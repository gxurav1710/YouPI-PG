import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { getAdminToken } from '@youpi/common';
import { startControlCenter } from '../index.js';
import { ProcessManager } from '../process-manager.js';

const ADMIN_AUTH = { Authorization: `Bearer ${getAdminToken()}` };

describe('Control Center Supervisor Integration Tests', () => {
  let ccInstance;
  let baseUrl;
  let pm;

  before(async () => {
    pm = new ProcessManager();
    // Start on test port 8190
    ccInstance = await startControlCenter(8190, { processManager: pm });
    baseUrl = `http://localhost:${ccInstance.port}`;
  });

  after(async () => {
    await ccInstance.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }).on('error', reject);
    });
  }

  function post(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method: 'POST', headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'UP');
    assert.equal(res.body.service, 'control-center');
  });

  test('GET / renders operational console HTML with all components', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('YOUPI Control Center'));
    assert.ok(res.body.includes('Managed host processes'));
    assert.ok(res.body.includes('Live logs, all services'));
  });

  test('process control routes require the admin token', async () => {
    assert.equal((await get('/api/services')).status, 401);
    assert.equal((await get('/api/logs/stream')).status, 401);
    assert.equal((await post('/api/services/stop-all')).status, 401);
  });

  test('GET /api/services enumerates all modular host services', async () => {
    const res = await get('/api/services', ADMIN_AUTH);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 6);

    const ids = res.body.map(s => s.id);
    assert.ok(ids.includes('payment-api'));
    assert.ok(ids.includes('checkout-portal'));
    assert.ok(ids.includes('merchant-admin'));
    assert.ok(ids.includes('gmail-observer'));
    assert.ok(ids.includes('sms-observer'));
    assert.ok(ids.includes('coin-wallet-store'));

    for (const s of res.body) {
      assert.equal(s.status, 'STOPPED');
      assert.ok(s.port > 0);
    }
  });

  test('Log buffer captures entries and limits size', () => {
    pm.appendLog('payment-api', 'stdout', 'Server initialized on port 6100\nConnected to database');
    assert.ok(pm.logs.length >= 2);
    assert.equal(pm.logs[pm.logs.length - 1].serviceId, 'payment-api');
    assert.equal(pm.logs[pm.logs.length - 1].line, 'Connected to database');
  });

  test('CRITICAL INVARIANT: Stop All strictly stops child processes and NEVER terminates Control Center', async () => {
    const res = await post('/api/services/stop-all', ADMIN_AUTH);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    // Verify Control Center is still alive and responsive!
    const healthCheck = await get('/health');
    assert.equal(healthCheck.status, 200);
    assert.equal(healthCheck.body.status, 'UP');
  });
});

describe('ProcessManager child lifecycle', () => {
  // Windows has no catchable SIGTERM: child.kill('SIGTERM') terminates the child at
  // once, so the fixture's graceful handler never runs and exitCode stays null.
  // Ordering invariants still hold there; only the exit-code/escalation checks differ.
  const POSIX_SIGNALS = process.platform !== 'win32';
  const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;
  function assertStopped(child) {
    if (POSIX_SIGNALS) assert.equal(child.exitCode, 0);
    else assert.ok(hasExited(child), 'the child must have exited');
  }

  function fixture(t, shutdownBody, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-process-test-'));
    const script = path.join(directory, 'service.cjs');
    fs.writeFileSync(script, `
      process.on('SIGTERM', () => { ${shutdownBody} });
      setInterval(() => {}, 1000);
      process.send('ready');
    `);
    const pm = new ProcessManager(options);
    pm.services = [{ id: 'fixture', name: 'Lifecycle fixture', script, port: 1, status: 'STOPPED', child: null }];
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
      pm,
      children,
      async start() {
        const svc = await pm.startService('fixture');
        children.push(svc.child);
        await once(svc.child, 'message');
        return svc;
      }
    };
  }

  test('stopService resolves only after the child exits', async (t) => {
    const { pm, start } = fixture(t, 'setTimeout(() => process.exit(0), 100);');
    const svc = await start();
    const child = svc.child;
    const stopping = pm.stopService('fixture');
    assert.ok(svc.child === child, 'the process must remain tracked while it is alive');
    await stopping;
    assertStopped(child);
    assert.equal(svc.child, null);
    assert.equal(svc.status, 'STOPPED');
    assert.equal(svc.pid, null);
  });

  test('restart waits for a slow shutdown and retains the replacement child', async (t) => {
    const { pm, start, children } = fixture(t, 'setTimeout(() => process.exit(0), 800);');
    const svc = await start();
    const original = svc.child;
    const originalExit = once(original, 'exit');
    await pm.restartService('fixture');
    const replacement = svc.child;
    children.push(replacement);
    await once(replacement, 'message');
    const originalExitedBeforeReplacement = hasExited(original);
    await originalExit;

    assert.equal(originalExitedBeforeReplacement, true, 'replacement must start after the original exits');
    assert.notEqual(replacement.pid, original.pid);
    assert.equal(svc.child, replacement, 'an old exit event must not detach the replacement');
    assert.equal(svc.pid, replacement.pid);
    assert.equal(svc.status, 'RUNNING');
  });

  test('a start arriving during stop waits instead of spawning an overlapping child', async (t) => {
    const { pm, start, children } = fixture(t, 'setTimeout(() => process.exit(0), 100);');
    const svc = await start();
    const original = svc.child;
    const stopping = pm.stopService('fixture');
    const restarting = pm.startService('fixture');
    await stopping;
    await restarting;
    const replacement = svc.child;
    children.push(replacement);
    await once(replacement, 'message');

    assertStopped(original);
    assert.notEqual(replacement.pid, original.pid);
    assert.equal(svc.child, replacement);
    assert.equal(svc.status, 'RUNNING');
  });

  test('a child ignoring SIGTERM is killed after the graceful shutdown deadline', {
    skip: !POSIX_SIGNALS && 'SIGTERM cannot be ignored on Windows, so there is no deadline to escalate from'
  }, async (t) => {
    const { pm, start } = fixture(t, '', { stopTimeoutMs: 50 });
    const svc = await start();
    const original = svc.child;
    await pm.stopService('fixture');

    assert.equal(original.signalCode, 'SIGKILL');
    assert.equal(svc.status, 'STOPPED');
    assert.equal(svc.child, null);
  });
});
