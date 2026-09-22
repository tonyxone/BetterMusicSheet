import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/library-pagination.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const api = load();

// Same component, same rule for a signed-in account or a guest - LibraryView
// doesn't branch on who's viewing, only on how many sheets they have.

test('an empty library is a single page, and the demo stands alone', () => {
  const p = api.paginateLibrary(0, 1);
  assert.equal(p.pageCount, 1);
  assert.equal(p.currentPage, 1);
  assert.equal(p.showDemoLast, true);
  assert.equal(p.emptyLibrary, true);
});

test('a library that fits on one page shows the demo after it, not the empty state', () => {
  const p = api.paginateLibrary(3, 1);
  assert.equal(p.pageCount, 1);
  assert.equal(p.showDemoLast, true);
  assert.equal(p.emptyLibrary, false);
});

test('the demo only shows on the last page of a paginated library - never in the middle', () => {
  const page1 = api.paginateLibrary(25, 1, 10);
  assert.equal(page1.pageCount, 3);
  assert.equal(page1.showDemoLast, false);

  const page2 = api.paginateLibrary(25, 2, 10);
  assert.equal(page2.showDemoLast, false);

  const page3 = api.paginateLibrary(25, 3, 10);
  assert.equal(page3.showDemoLast, true);
  assert.equal(page3.emptyLibrary, false);
});

test('a requested page past the end clamps to the last page, which still shows the demo', () => {
  const p = api.paginateLibrary(12, 99, 10);
  assert.equal(p.pageCount, 2);
  assert.equal(p.currentPage, 2);
  assert.equal(p.showDemoLast, true);
});

test('a page number below 1 clamps up to the first page', () => {
  const p = api.paginateLibrary(12, 0, 10);
  assert.equal(p.currentPage, 1);
});

test('slice bounds match the requested page', () => {
  const p = api.paginateLibrary(25, 2, 10);
  assert.equal(p.start, 10);
  assert.equal(p.end, 20);
});
