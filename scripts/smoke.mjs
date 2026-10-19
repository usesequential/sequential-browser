// The built package loads both ways, with no window it does nothing and throws nothing, and its version is
// package.json's. Runs before every publish.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${PKG}package.json`, 'utf8'));
const METHODS = ['capture', 'identify', 'account', 'register', 'unregister', 'reset', 'optOut', 'optIn', 'captureException', 'flush'];

const cjs = createRequire(import.meta.url)(`${PKG}dist/index.cjs`);
const esm = await import(`${PKG}dist/index.mjs`);
for (const mod of [cjs, esm]) {
  assert.strictEqual(mod.VERSION, version);
  assert.strictEqual(typeof mod.init, 'function');
  const sq = mod.init({ key: 'sq_sequential_smoke', api: 'https://api.usesequential.com' });
  for (const m of METHODS) assert.strictEqual(typeof sq[m], 'function', m);
  sq.capture('server_render');
  await sq.flush();
}
assert.strictEqual(typeof globalThis.sequential, 'undefined');
console.log(`smoke ok: require + import, version ${version}, inert without a window`);
