import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// The selection rules only; stitching photos into a PDF needs a browser.
function load() {
  const source = fs.readFileSync(new URL('../lib/photo-pages.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const api = load();
const pdf = (name = 'Score.pdf') => ({ name, type: 'application/pdf' });
const photo = (name) => ({ name, type: 'image/jpeg' });
// Names, compared as plain arrays: results cross the vm's realm boundary.
const names = (files) => Array.from(files, (f) => f.name);

test('several photos become one selection, in the order picked', () => {
  const { files, error } = api.addFiles([], [photo('p1.jpg'), photo('p2.jpg')]);
  assert.equal(error, null);
  assert.deepEqual(names(files), ['p1.jpg', 'p2.jpg']);
});

test('photos picked later are added after the ones already there', () => {
  const { files } = api.addFiles([photo('p1.jpg')], [photo('p2.png'), photo('p3.jpeg')]);
  assert.deepEqual(names(files), ['p1.jpg', 'p2.png', 'p3.jpeg']);
});

test('a PDF and photos together are refused, however they are added', () => {
  for (const [current, incoming] of [
    [[], [pdf(), photo('p1.jpg')]],          // in one pick
    [[photo('p1.jpg')], [pdf()]],            // a PDF after photos
    [[pdf()], [photo('p1.jpg')]],            // photos after a PDF
  ]) {
    const { files, error } = api.addFiles(current, incoming);
    assert.match(error, /can't be uploaded together/);
    assert.deepEqual(names(files), names(current), 'the selection is left as it was');
  }
});

test('one PDF at a time, and a new PDF replaces the old one', () => {
  assert.match(api.addFiles([], [pdf('a.pdf'), pdf('b.pdf')]).error, /one PDF at a time/);
  assert.deepEqual(names(api.addFiles([pdf('a.pdf')], [pdf('b.pdf')]).files), ['b.pdf']);
});

test('unsupported files and too many pages are refused', () => {
  assert.match(api.addFiles([], [{ name: 'notes.docx', type: 'application/msword' }]).error, /Only PDF, JPG and PNG/);
  const many = Array.from({ length: api.MAX_PHOTOS }, (_, i) => photo(`p${i}.jpg`));
  assert.equal(api.addFiles([], many).error, null);
  assert.match(api.addFiles(many, [photo('extra.jpg')]).error, /at most 50 pages/);
});

test('a page dragged to a new place moves there, the rest keeping their order', () => {
  const files = [photo('a.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg')];
  assert.deepEqual(names(api.moveFile(files, 3, 0)), ['d.jpg', 'a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(names(api.moveFile(files, 0, 2)), ['b.jpg', 'c.jpg', 'a.jpg', 'd.jpg']);
  assert.deepEqual(names(api.moveFile(files, 1, 2)), ['a.jpg', 'c.jpg', 'b.jpg', 'd.jpg']);
  // Nowhere to go: unchanged.
  assert.deepEqual(names(api.moveFile(files, 0, -1)), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  assert.deepEqual(names(api.moveFile(files, 3, 4)), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  assert.deepEqual(names(api.moveFile(files, 2, 2)), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
});

test('pages can be removed', () => {
  const files = [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')];
  assert.deepEqual(names(api.removeFile(files, 1)), ['a.jpg', 'c.jpg']);
});
