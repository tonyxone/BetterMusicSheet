import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/browser-support.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ReferenceError });
  return exports;
}

test('the errors old browsers actually produced are recognised', () => {
  const { isMissingBrowserFeature } = load();
  // Verbatim from the two reports this exists because of.
  assert.ok(isMissingBrowserFeature(new TypeError('hashOriginal.toHex is not a function')),
    'Safari before 18.2, missing the Uint8Array hex methods');
  assert.ok(isMissingBrowserFeature(new ReferenceError("Can't find variable: Iterator")),
    'Safari before 18.4, missing the Iterator global');
  // Other engines phrase the same two failures differently.
  assert.ok(isMissingBrowserFeature(new ReferenceError('Iterator is not defined')), 'V8');
  assert.ok(isMissingBrowserFeature(new TypeError('undefined is not an object')), 'JavaScriptCore');
});

test('ordinary failures are not blamed on the browser', () => {
  const { isMissingBrowserFeature } = load();
  // Telling someone to update their browser when the network failed, or when
  // the file is broken, is worse than saying nothing.
  assert.equal(isMissingBrowserFeature(new Error('Failed to fetch')), false);
  assert.equal(isMissingBrowserFeature(new Error('Invalid PDF structure')), false);
  assert.equal(isMissingBrowserFeature(new Error('The API returned 500')), false);
  assert.equal(isMissingBrowserFeature('rendering cancelled'), false);
});
