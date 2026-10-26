// First-paint payload of a built web root: follows <script>/<link> tags and static `import ... from` edges (dynamic import() is lazy and excluded),
// and reports raw and gzip sizes. Usage: node tools/payload.mjs mobile/www
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
const root = resolve(process.argv[2] || 'mobile/www'); const seen = new Map();
const add = (p) => { if (seen.has(p) || !existsSync(p)) return; const b = readFileSync(p); seen.set(p, { raw: b.length, gz: gzipSync(b, { level: 9 }).length });
  if (/\.js$/.test(p)) for (const m of b.toString().matchAll(/(?:^|[;\n])\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) { const t = m[1] || m[2]; if (t.startsWith('.')) add(resolve(dirname(p), t)); } };
const html = readFileSync(join(root, 'index.html'), 'utf8'); add(join(root, 'index.html'));
for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) add(join(root, m[1]));
// data.js loads the app after the sign-in check with a dynamic import; for a signed-in start that is part of first paint, so include it explicitly
const dataJs = join(root, 'js', 'data.js'); if (existsSync(dataJs)) add(join(root, 'js', 'app.js'));
const groups = { 'html+css': /\.(html|css)$/, 'app js': /\/js\//, 'on-device engine js': /\/engine|engine-boot/ };
let tot = { raw: 0, gz: 0 }; const by = {};
for (const [p, s] of seen) { const g = Object.entries(groups).find(([, re]) => re.test(p.replace(root, '')))?.[0] || 'other'; by[g] ||= { raw: 0, gz: 0, files: 0 }; by[g].raw += s.raw; by[g].gz += s.gz; by[g].files++; tot.raw += s.raw; tot.gz += s.gz; }
for (const [g, v] of Object.entries(by)) console.log(`${g.padEnd(22)} ${String(v.files).padStart(2)} files ${String(v.raw).padStart(7)} raw ${String(v.gz).padStart(6)} gzip`);
console.log(`${'TOTAL first paint'.padEnd(22)} ${String(seen.size).padStart(2)} files ${String(tot.raw).padStart(7)} raw ${String(tot.gz).padStart(6)} gzip`);
