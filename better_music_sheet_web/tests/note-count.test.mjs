import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/note-count.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const { noteCountLabel } = load();

test('a vector PDF shows notes labeled out of notes printed', () => {
  assert.equal(noteCountLabel({ status: 'done', notes_named: 606, notes_printed: 634 }), '606/634 notes labeled');
  assert.equal(noteCountLabel({ status: 'done', notes_named: 1804, notes_printed: 1804 }), '1,804/1,804 notes labeled');
});

test('never more labeled than the sheet prints', () => {
  assert.equal(noteCountLabel({ status: 'done', notes_named: 640, notes_printed: 634 }), '634/634 notes labeled');
});

test('a photo or scan has no printed total, so only the named count', () => {
  assert.equal(noteCountLabel({ status: 'done', notes_named: 275, notes_printed: null }), '275 notes labeled');
});

test('nothing for sheets without counts, or not finished', () => {
  assert.equal(noteCountLabel({ status: 'done' }), null);
  assert.equal(noteCountLabel({ status: 'processing', notes_named: null }), null);
  assert.equal(noteCountLabel({ status: 'failed', notes_named: 10, notes_printed: 20 }), null);
});
