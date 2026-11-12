import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/sheet-title.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}), Intl });
  return exports;
}

const api = load();

test('a title is cleaned the way the server stores it', () => {
  assert.equal(api.cleanTitle('  Clair   de\nLune\t'), 'Clair de Lune');
  assert.equal(api.cleanTitle('Bell\u0007 song\u0000'), 'Bell song');
  assert.equal(api.cleanTitle('夏日漱石 🎹'), '夏日漱石 🎹');
  assert.equal(api.cleanTitle(' \n\t　 '), '');
});

test('photographed pages are offered "Scan" and the date and time', () => {
  const date = new Date(2026, 10, 11, 15, 42);
  const title = api.defaultScanTitle('Scan {date}', date, 'en-US');
  assert.equal(title, `Scan ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`);
  assert.match(title, /^Scan Nov 11, 2026/);
  // Another language's wording keeps the date where it puts it.
  assert.match(api.defaultScanTitle('スキャン {date}', date, 'ja'), /^スキャン 2026/);
  // Two scans a minute apart are named apart.
  assert.notEqual(title, api.defaultScanTitle('Scan {date}', new Date(2026, 10, 11, 15, 43), 'en-US'));
});

test('a chosen file is offered under its own name, without the extension', () => {
  assert.equal(api.titleFromFileName('Menuet in G.pdf'), 'Menuet in G');
  assert.equal(api.titleFromFileName('IMG_2041.png'), 'IMG_2041');
  assert.equal(api.titleFromFileName('Op. 2 No. 1.pdf'), 'Op. 2 No. 1');
  assert.equal(api.titleFromFileName('  Clair\tde  Lune .jpeg'), 'Clair de Lune');
  assert.equal(api.titleFromFileName('No extension'), 'No extension');
  assert.equal(api.titleFromFileName(`${'x'.repeat(300)}.pdf`).length, api.TITLE_MAX_LENGTH);
});

test('a camera shot\'s generic name is not offered', () => {
  for (const name of ['image.jpg', 'image (2).jpg', 'IMAGE.JPEG', 'photo.jpg', '1731340000000.jpg', 'Page.jpg', '.jpg', '']) {
    assert.equal(api.titleFromFileName(name), '', name);
  }
});

test('the offered name is the first file\'s, else Scan and the date', () => {
  const date = new Date(2026, 10, 11, 15, 42);
  const scan = api.defaultScanTitle('Scan {date}', date, 'en-US');
  assert.equal(api.defaultSheetName([{ name: 'Menuet in G.pdf' }], 'Scan {date}', date, 'en-US'), 'Menuet in G');
  assert.equal(api.defaultSheetName([{ name: 'IMG_2041.png' }, { name: 'IMG_2042.png' }], 'Scan {date}', date, 'en-US'),
    'IMG_2041');
  assert.equal(api.defaultSheetName([{ name: 'image.jpg' }], 'Scan {date}', date, 'en-US'), scan);
  assert.equal(api.defaultSheetName([], 'Scan {date}', date, 'en-US'), scan);
});

test('a sheet is called by its title, else its filename without the extension', () => {
  assert.equal(api.sheetTitle({ title: 'Gymnopédie No. 1', sheet_name: 'IMG_0412.jpg' }), 'Gymnopédie No. 1');
  assert.equal(api.sheetTitle({ title: null, sheet_name: 'Menuet in G.pdf' }), 'Menuet in G');
  assert.equal(api.sheetTitle({ sheet_name: 'No extension' }), 'No extension');
  assert.equal(api.sheetTitle({ sheet_name: '.pdf' }), '.pdf');
  assert.equal(api.sheetTitle({}), '');
});

test('the original is downloaded with the extension it was uploaded with', () => {
  assert.equal(api.uploadExtension({ sheet_name: 'IMG_0412.JPG' }), '.JPG');
  assert.equal(api.uploadExtension({ sheet_name: 'Menuet in G.pdf' }), '.pdf');
  assert.equal(api.uploadExtension({ sheet_name: 'No extension' }), '');
  assert.equal(api.uploadExtension({}), '');
});

test('the length cap matches the server', () => {
  assert.equal(api.TITLE_MAX_LENGTH, 255);
});
