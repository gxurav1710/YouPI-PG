import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const nodeModules = path.join(root, 'node_modules');
const youpiScope = path.join(nodeModules, '@youpi');

fs.mkdirSync(youpiScope, { recursive: true });

// Link packages into node_modules/@youpi/
const packagesDir = path.join(root, 'packages');
for (const name of fs.readdirSync(packagesDir)) {
  const target = path.join(packagesDir, name);
  const link = path.join(youpiScope, name);
  if (fs.existsSync(link)) continue;
  try {
    fs.symlinkSync(target, link, 'junction');
    console.log(`Linked @youpi/${name}`);
  } catch (err) {
    console.error(`Failed to link @youpi/${name}: ${err.message}`);
  }
}

// Link apps into node_modules/
const appsDir = path.join(root, 'apps');
for (const name of fs.readdirSync(appsDir)) {
  const target = path.join(appsDir, name);
  const link = path.join(nodeModules, name);
  if (fs.existsSync(link)) continue;
  try {
    fs.symlinkSync(target, link, 'junction');
    console.log(`Linked ${name}`);
  } catch (err) {
    console.error(`Failed to link ${name}: ${err.message}`);
  }
}
console.log('Workspaces linking complete.');
