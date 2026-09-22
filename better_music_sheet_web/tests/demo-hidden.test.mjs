import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(clientApiFetch, localStorage) {
  const source = fs.readFileSync(new URL('../lib/demo-hidden.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({ clientApiFetch }), localStorage, Response });
  return exports;
}

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('a guest with nothing stored yet reads as not hidden', () => {
  const api = load(undefined, fakeStorage());
  assert.equal(api.readLocalDemoHidden(), false);
});

test('a guest hide/show round-trips through localStorage', () => {
  const storage = fakeStorage();
  const api = load(undefined, storage);
  api.writeLocalDemoHidden(true);
  assert.equal(api.readLocalDemoHidden(), true);
  api.writeLocalDemoHidden(false);
  assert.equal(api.readLocalDemoHidden(), false);
});

test('a browser that refuses localStorage fails open to not-hidden and does not throw', () => {
  const api = load(undefined, undefined);
  assert.equal(api.readLocalDemoHidden(), false);
  assert.doesNotThrow(() => api.writeLocalDemoHidden(true));
});

test('a signed-in account reads its hidden state from the API', async () => {
  const paths = [];
  const api = load(async (path) => { paths.push(path); return Response.json({ hidden: true }); }, fakeStorage());
  assert.equal(await api.fetchDemoHidden(), true);
  assert.equal(paths[0], '/api/me/demo-hidden');
});

test('a failed or unauthorized read is treated as not hidden', async () => {
  const api = load(async () => new Response(null, { status: 401 }), fakeStorage());
  assert.equal(await api.fetchDemoHidden(), false);
});

test('saving a signed-in hide sends a PUT with the new value', async () => {
  const calls = [];
  const api = load(async (path, init) => { calls.push([path, init]); return new Response(null, { status: 200 }); }, fakeStorage());
  await api.saveDemoHidden(true);
  assert.equal(calls[0][0], '/api/me/demo-hidden');
  assert.equal(calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0][1].body), { hidden: true });
});
