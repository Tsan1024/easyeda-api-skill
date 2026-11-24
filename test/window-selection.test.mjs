import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';

// Exercise the actual server in its own process. Never attach to an existing
// bridge: startup must print its own listening banner before we connect.
test('window selection preserves the bridge and routes execution', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, ['scripts/bridge-server.mjs'], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = once(child, 'exit');
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });

  const deadline = Date.now() + 10000;
  while (!output.includes('HTTP API:')) {
    assert.equal(child.exitCode, null, `Bridge exited before listening: ${output}`);
    assert.ok(Date.now() < deadline, `Bridge did not start: ${output}`);
    await delay(20);
  }
  const port = output.match(/HTTP API:\s+http:\/\/localhost:(\d+)/)[1];
  const base = `http://127.0.0.1:${port}`;
  async function request(path, body) {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return { status: response.status, body: await response.json() };
  }
  for (const windowId of ['w1', 'w2']) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/eda`);
    clients.push(ws);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'execute') {
        ws.send(JSON.stringify({ type: 'result', id: message.id, result: windowId }));
      }
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'register', windowId }));
  }
  while ((await request('/eda-windows')).body.count !== 2) {
    assert.ok(Date.now() < deadline, 'Windows did not register');
    await delay(20);
  }

  for (const windowId of ['w2', 'w1', 'w1']) {
    assert.deepEqual(await request('/eda-windows/select', JSON.stringify({ windowId })), {
      status: 200, body: { success: true, activeWindowId: windowId },
    });
    assert.equal((await request('/health')).body.activeWindowId, windowId);
    const windows = (await request('/eda-windows')).body;
    assert.equal(windows.activeWindowId, windowId);
    assert.deepEqual(windows.windows.filter((w) => w.active).map((w) => w.windowId), [windowId]);
    assert.deepEqual(await request('/execute', JSON.stringify({ code: 'return 1;' })), {
      status: 200, body: { success: true, result: windowId, windowId },
    });
  }
  for (const body of ['{', 'null']) {
    assert.deepEqual(await request('/eda-windows/select', body), {
      status: 400, body: { error: 'Invalid request body' },
    });
  }
  assert.deepEqual(await request('/eda-windows/select', '{"windowId":"missing"}'), {
    status: 404, body: { error: 'EDA window "missing" not found' },
  });
  assert.equal((await request('/health')).body.activeWindowId, 'w1');
  assert.deepEqual(await request('/execute', '{"code":"return 1;"}'), {
    status: 200, body: { success: true, result: 'w1', windowId: 'w1' },
  });
});
