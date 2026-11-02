import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../packages/db/src/migrate.js';
import { startControlCenter } from '../apps/control-center/src/index.js';
import { startCloudflaredSafely } from '../packages/common/src/tunnel-command.js';

if (!process.env.YOUPI_MODE) process.env.YOUPI_MODE = 'localhost';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

// Load the shared configuration before migrations and service discovery. Set the
// dev defaults first so .env cannot override them; explicit shell values still win.
const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

console.log('====================================================');
console.log('🚀 Starting YOUPI PG (Development / Localhost Mode)');
console.log('====================================================');

// 1. Run database migrations & seeds
console.log('[1/2] Checking and applying database migrations...');
const migrationResult = runMigrations();
console.log(`[✓] Database ready. Default merchant: ${migrationResult.defaultMerchant.businessName}`);

// Check for user-configured Cloudflare Tunnel command
let tunnelProcess = null;
const branding = migrationResult.defaultMerchant?.branding || {};
const tunnelCmd = process.env.CLOUDFLARE_TUNNEL_COMMAND || branding.cloudflareTunnelCommand;

if (tunnelCmd && tunnelCmd.trim()) {
  console.log(`\n[☁️ Cloudflare Tunnel] Executing tunnel command before starting services:`);
  tunnelProcess = startCloudflaredSafely(tunnelCmd, { stdio: 'inherit' });
  if (tunnelProcess) console.log(`[✓] Cloudflare Tunnel process launched (PID: ${tunnelProcess.pid}).\n`);
  // Brief pause to establish socket before services spin up
  await new Promise(r => setTimeout(r, 1500));
}

// 2. Start Control Center supervisor and launch all services
console.log('[2/2] Launching Local Process Control Center...');
const cc = await startControlCenter();

console.log(`\n[✓] Control Center is online at: http://localhost:${cc.port}`);
console.log('[*] Starting all modular gateway services...\n');

await cc.processManager.startAll();

console.log('====================================================');
console.log('🟢 ALL SERVICES ONLINE & OPERATIONAL');
console.log('====================================================');
console.log('• Merchant Panel & Control Hub: http://localhost:6001');
console.log('• Payment Core REST API:        http://localhost:6100');
console.log('• Customer Checkout Portal:     http://localhost:7000/checkout/:id');
console.log('• YOUPI Showcase Store:        http://localhost:5000 (toggleable)');
console.log('• Gmail Payment Observer:       http://localhost:6003');
console.log('• Google Messages / SMS Obs:    http://localhost:6002');
console.log('====================================================');
console.log('Press Ctrl+C to stop all services gracefully.');

// Handle graceful shutdown
const shutdown = async () => {
  console.log('\nStopping all services gracefully...');
  if (tunnelProcess && tunnelProcess.pid) {
    try {
      console.log('Terminating Cloudflare Tunnel process...');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(tunnelProcess.pid), '/f', '/t']);
      } else {
        tunnelProcess.kill('SIGTERM');
      }
    } catch {}
  }
  await cc.close();
  console.log('All processes terminated cleanly.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

