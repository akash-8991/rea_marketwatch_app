// Assemble mobile/www: the desktop web UI (unchanged, copied from src/marketlens/static) + the on-device engine.
// Usage: node mobile/scripts/build-www.mjs        (no dependencies)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, '..'), root = join(mobile, '..');
const www = join(mobile, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(join(root, 'src', 'marketlens', 'static'), www, { recursive: true });
cpSync(join(mobile, 'engine'), join(www, 'engine'), { recursive: true });

// Installs the on-device engine before the UI's first request.
writeFileSync(join(www, 'engine-boot.js'), "import { installEngine } from './engine/shim.js';\ninstallEngine();\n");

let html = readFileSync(join(www, 'index.html'), 'utf8');
if (!html.includes('js/data.js')) throw new Error('index.html changed: cannot find the data.js script tag');
html = html
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
  .replace('<script type="module" src="js/data.js"></script>', '<script type="module" src="engine-boot.js"></script>\n  <script type="module" src="js/data.js"></script>')
  .replace('MarketLens is a local tool using NSE data for information only. Not investment advice.', 'MarketLens runs entirely on this phone and uses NSE data for information only. Not investment advice.');
writeFileSync(join(www, 'index.html'), html);

// Wording that says "computer" is wrong on a phone.
const authPath = join(www, 'js', 'auth.js');
writeFileSync(authPath, readFileSync(authPath, 'utf8').replace('stored only in the database on this computer', 'stored only on this phone'));
console.log('built', www);
