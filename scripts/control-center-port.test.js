import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runLauncher(t, script, { port, dotenvPort } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-control-port-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  function write(relativePath, contents) {
    const target = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  write('package.json', '{"type":"module"}');
  // Exercise the real entrypoint and existing port resolver; substitute only
  // database/service startup and the listener so tests never claim shared ports.
  for (const relativePath of [
    `scripts/${script}`,
    'apps/control-center/src/index.js',
    'packages/common/src/runtime-config.js'
  ]) {
    write(relativePath, fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
  }
  write('packages/db/src/migrate.js', `
    export function runMigrations() {
      return { defaultMerchant: { businessName: 'Port fixture', branding: {} } };
    }
  `);
  write('packages/common/src/tunnel-command.js', `
    export function startCloudflaredSafely() { throw new Error('Unexpected tunnel startup'); }
  `);
  write('apps/control-center/src/process-manager.js', `
    export class ProcessManager {
      async startAll() { console.log('SERVICES_STARTED'); }
      async stopAll() {}
    }
  `);
  write('apps/control-center/src/server.js', `
    export class ControlCenterServer {
      createServer() {
        return {
          listen(port, host, ready) {
            console.log('LISTEN_ARGUMENTS ' + JSON.stringify({ port, host }));
            queueMicrotask(ready);
            return { close(done) { done(); } };
          }
        };
      }
    }
  `);
  if (dotenvPort !== undefined) write('.env', `CONTROL_CENTER_PORT=${dotenvPort}\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(YOUPI_|CLOUDFLARE_|DEPLOYMENT_|NODE_)/.test(key) || key === 'CONTROL_CENTER_PORT') delete env[key];
  }
  env.CLOUDFLARE_DOMAIN = 'port-fixture.example';
  if (port !== undefined) env.CONTROL_CENTER_PORT = String(port);
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', script)], {
    cwd: fixture, env, encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const listenLine = result.stdout.split('\n').find(line => line.startsWith('LISTEN_ARGUMENTS '));
  assert.ok(listenLine, result.stdout);
  assert.match(result.stdout, /SERVICES_STARTED/);
  return { ...JSON.parse(listenLine.slice('LISTEN_ARGUMENTS '.length)), output: result.stdout };
}

for (const script of ['dev.js', 'start.js']) {
  test(`${script} honors CONTROL_CENTER_PORT from its process environment`, t => {
    const result = runLauncher(t, script, { port: 18090 });
    assert.equal(result.port, 18090);
    assert.equal(result.host, '127.0.0.1');
    assert.match(result.output, /Control Center is online at: http:\/\/localhost:18090/);
  });

  test(`${script} keeps the default control-center port when none is configured`, t => {
    assert.equal(runLauncher(t, script).port, 8090);
  });
}

test('start.js honors CONTROL_CENTER_PORT loaded from the project .env', t => {
  assert.equal(runLauncher(t, 'start.js', { dotenvPort: 18091 }).port, 18091);
});

test('start.js keeps an explicit process port ahead of the .env fallback', t => {
  assert.equal(runLauncher(t, 'start.js', { port: 18092, dotenvPort: 18091 }).port, 18092);
});
