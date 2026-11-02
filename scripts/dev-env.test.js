import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runDev(t, { envFile, shellEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi dev env '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');

  // Exercise the real launcher, migrations, SQLite and child-process environment
  // in a scratch checkout. Only network-facing servers are replaced with fixtures.
  for (const name of ['common', 'db']) {
    const destination = path.join(root, 'packages', name);
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'packages', name, 'src'), path.join(destination, 'src'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'packages', name, 'package.json'), path.join(destination, 'package.json'));
  }
  fs.mkdirSync(path.join(root, 'node_modules', '@youpi'), { recursive: true });
  fs.symlinkSync(path.join(root, 'packages', 'common'), path.join(root, 'node_modules', '@youpi', 'common'),
    process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'dev.js'), path.join(root, 'scripts', 'dev.js'));
  fs.mkdirSync(path.join(root, 'apps', 'control-center', 'src'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'apps', 'control-center', 'src', 'process-manager.js'),
    path.join(root, 'apps', 'control-center', 'src', 'process-manager.js'));
  if (envFile !== undefined) fs.writeFileSync(path.join(root, '.env'), envFile);

  fs.mkdirSync(path.join(root, 'apps', 'payment-api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'payment-api', 'src', 'index.js'), `
import { getDatabase } from '../../../packages/db/src/database.js';
const db = getDatabase();
console.log('CHILD_CONFIG ' + JSON.stringify({
  database: db.queryOne('PRAGMA database_list').file,
  merchant: db.queryOne('SELECT business_name FROM merchants').business_name,
  port: Number(process.env.PAYMENT_API_PORT || 6100),
  nodeEnv: process.env.NODE_ENV,
  mode: process.env.YOUPI_MODE
}));
db.close();
`);
  fs.writeFileSync(path.join(root, 'apps', 'control-center', 'src', 'index.js'), `
import { once } from 'node:events';
import { ProcessManager } from './process-manager.js';
import { getDatabase } from '../../../packages/db/src/database.js';
export async function startControlCenter() {
  const manager = new ProcessManager();
  const db = getDatabase();
  console.log('PARENT_CONFIG ' + JSON.stringify({
    database: db.queryOne('PRAGMA database_list').file,
    merchant: db.queryOne('SELECT business_name FROM merchants').business_name,
    port: manager.getService('payment-api').port,
    nodeEnv: process.env.NODE_ENV,
    mode: process.env.YOUPI_MODE
  }));
  manager.on('log', entry => console.log(entry.line));
  manager.startAll = async () => {
    const service = await manager.startService('payment-api');
    const [code] = await once(service.child, 'exit');
    if (code !== 0) throw new Error('Fixture child exited with code ' + code);
  };
  return { processManager: manager, close: async () => {} };
}
`);

  // Launch outside the repository root to require module-relative .env lookup.
  const cwd = path.join(root, 'another working directory');
  fs.mkdirSync(cwd);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'dev.js')], {
    cwd,
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...shellEnv },
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}\n${result.stdout}`);
  const readConfig = prefix => {
    const line = result.stdout.split('\n').find(value => value.startsWith(prefix));
    assert.ok(line, result.stdout);
    const config = JSON.parse(line.slice(prefix.length));
    config.database = path.relative(fs.realpathSync(root), config.database);
    return config;
  };
  return {
    parent: readConfig('PARENT_CONFIG '),
    child: readConfig('CHILD_CONFIG '),
    defaultDatabaseExists: fs.existsSync(path.join(root, 'data', 'youpi_pg.sqlite'))
  };
}

const configuredEnv = [
  'SQLITE_DB_PATH=./data/configured.sqlite',
  'DEFAULT_MERCHANT_NAME="Configured Fixture Merchant"',
  'PAYMENT_API_PORT=16100'
].join('\n');

test('dev loads root .env before migrating and constructing the service registry', t => {
  const { parent, child, defaultDatabaseExists } = runDev(t, { envFile: configuredEnv });
  assert.deepEqual(parent, {
    database: path.join('data', 'configured.sqlite'),
    merchant: 'Configured Fixture Merchant',
    port: 16100,
    nodeEnv: 'development',
    mode: 'localhost'
  });
  assert.deepEqual(child, parent, 'supervisor and child must share the configured database and defaults');
  assert.equal(defaultDatabaseExists, false, 'dev must not migrate an unintended default database');
});

test('dev defaults keep priority over production modes in .env', t => {
  const { parent, child } = runDev(t, { envFile: `${configuredEnv}\nNODE_ENV=production\nYOUPI_MODE=production\n` });
  for (const config of [parent, child]) {
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.mode, 'localhost');
  }
});

test('dev still starts with shared defaults when .env is absent', t => {
  const { parent, child } = runDev(t);
  assert.deepEqual(parent, {
    database: path.join('data', 'youpi_pg.sqlite'),
    merchant: 'YOUPI Demo Store',
    port: 6100,
    nodeEnv: 'development',
    mode: 'localhost'
  });
  assert.deepEqual(child, parent);
});

test('explicit shell configuration retains priority over .env and dev defaults', t => {
  const { parent, child, defaultDatabaseExists } = runDev(t, {
    envFile: `${configuredEnv}\nNODE_ENV=development\nYOUPI_MODE=localhost\n`,
    shellEnv: {
      SQLITE_DB_PATH: './data/shell.sqlite',
      DEFAULT_MERCHANT_NAME: 'Shell Fixture Merchant',
      PAYMENT_API_PORT: '17100',
      NODE_ENV: 'production',
      YOUPI_MODE: 'production'
    }
  });
  assert.deepEqual(parent, {
    database: path.join('data', 'shell.sqlite'),
    merchant: 'Shell Fixture Merchant',
    port: 17100,
    nodeEnv: 'production',
    mode: 'production'
  });
  assert.deepEqual(child, parent);
  assert.equal(defaultDatabaseExists, false);
});
