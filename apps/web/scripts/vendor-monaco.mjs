import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vendors monaco-editor's AMD bundle into public/monaco/vs so editors and
 * diff views load from our own origin — the hosted demo and judge machines
 * must never reach for the jsdelivr CDN (plans/06 task 5b). Runs before
 * `dev` and `build`; public/monaco is gitignored (15MB of vendor assets).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const pkgPath = require.resolve('monaco-editor/package.json');
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

const src = path.join(path.dirname(pkgPath), 'min', 'vs');
const destRoot = path.join(here, '..', 'public', 'monaco');
const dest = path.join(destRoot, 'vs');
const marker = path.join(destRoot, '.version');

const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
if (current === version && existsSync(dest)) process.exit(0);

rmSync(destRoot, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
writeFileSync(marker, `${version}\n`);
console.log(`[vendor-monaco] monaco-editor ${version} → public/monaco/vs`);
