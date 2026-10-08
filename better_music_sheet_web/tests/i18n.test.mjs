import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');

// The i18n modules, run from their TypeScript source. React is only used by
// rich() to wrap parts in fragments; a stand-in records what it was given.
function load(entry) {
  const cache = new Map();
  const external = {
    react: { Fragment: 'Fragment', createElement: (type, props, child) => ({ type, key: props.key, child }) },
  };
  function require(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
      exports,
      require: (id) => external[id] ?? require(path.resolve(path.dirname(filename), id + '.ts')),
      Intl,
    });
    return exports;
  }
  return require(path.resolve(root, entry));
}

const config = load('lib/i18n/config.ts');
const format = load('lib/i18n/format.ts');
const { translateKnown } = load('lib/i18n/known-text.ts');
const { MESSAGES } = load('lib/i18n/messages/index.ts');
const { en } = load('lib/i18n/messages/en.ts');

test('browser languages map to the right script of Chinese, and the others', () => {
  const cases = [
    [['zh-CN'], 'zh-hans'], [['zh-SG'], 'zh-hans'], [['zh'], 'zh-hans'], [['zh-Hans-HK'], 'zh-hans'],
    [['zh-TW'], 'zh-hant'], [['zh-HK'], 'zh-hant'], [['zh-MO'], 'zh-hant'], [['zh-Hant'], 'zh-hant'],
    [['ja-JP'], 'ja'], [['ko-KR'], 'ko'], [['en-GB'], 'en'],
    [['fr-FR', 'ko'], 'ko'], [['de', 'fr'], null], [[], null],
  ];
  for (const [languages, expected] of cases) {
    assert.equal(config.matchLocale(languages), expected, languages.join(','));
  }
});

test('English keeps the unprefixed paths, every other language gets its own', () => {
  assert.equal(config.localePath('en', '/sheets?job=1'), '/sheets?job=1');
  assert.equal(config.localePath('ja', '/sheets?job=1'), '/ja/sheets?job=1');
  assert.equal(config.localePath('zh-hant', '/'), '/zh-hant/');
  assert.deepEqual({ ...config.splitLocale('/ko/play/') }, { locale: 'ko', path: '/play/' });
  assert.deepEqual({ ...config.splitLocale('/zh-hans/') }, { locale: 'zh-hans', path: '/' });
  assert.deepEqual({ ...config.splitLocale('/about/') }, { locale: 'en', path: '/about/' });
  // A path that merely starts like a language is not one.
  assert.deepEqual({ ...config.splitLocale('/japan/') }, { locale: 'en', path: '/japan/' });
});

test('fmt fills named slots and leaves unknown ones alone', () => {
  assert.equal(format.fmt('{a} of {b}', { a: 2, b: 5 }), '2 of 5');
  assert.equal(format.fmt('{a} and {missing}', { a: 1 }), '1 and {missing}');
});

test('plural picks the form a language uses', () => {
  const forms = { one: '{count} note', other: '{count} notes' };
  assert.equal(format.plural('en', 1, forms), '1 note');
  assert.equal(format.plural('en', 3, forms), '3 notes');
  assert.equal(format.plural('ja', 1, forms), '1 notes', 'Japanese has no singular form');
});

test('rich turns tags into elements, keeping the text around them in order', () => {
  const parts = format.rich('See <plans>plans</plans>, then {name}.', { plans: (t) => `[${t}]` }, { name: 'X' });
  // Spread into this realm's array: the module ran in its own context.
  assert.deepEqual([...parts.map((p) => p.child)], ['See ', '[plans]', ', then ', 'X', '.']);
});

// Collects every message string with its dotted key.
function strings(value, prefix = '', out = {}) {
  if (typeof value === 'string') out[prefix] = value;
  else for (const [key, child] of Object.entries(value)) strings(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

const slots = (text) => [...text.matchAll(/\{(\w+)\}|<(\w+)>/g)].map((m) => m[1] ?? `<${m[2]}>`).sort();

test('every language has every message, with the same slots and tags as English', () => {
  const english = strings(en);
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    const theirs = strings(messages);
    assert.deepEqual(Object.keys(theirs).sort(), Object.keys(english).sort(), `${locale}: keys`);
    for (const [key, text] of Object.entries(english)) {
      assert.deepEqual(slots(theirs[key]), slots(text), `${locale}: ${key}`);
    }
  }
});

test('the confirmation word is what the delete box asks for', () => {
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages.header.confirmWord.trim(), locale);
  }
});

test('job stages from the server are shown in the page language, part by part', () => {
  const zh = MESSAGES['zh-hans'];
  assert.equal(translateKnown('Reading sheet music', zh), '正在读谱');
  assert.equal(
    translateKnown('Reading sheet music (page 2 of 5) · about 3 minutes · 1,234 notes to read', zh),
    '正在读谱（第 2 页，共 5 页） · 大约 3 分钟 · 需要识别 1,234 个音符',
  );
  assert.equal(
    translateKnown('Re-reading unclear pages · re-reading them should take 2-4 minutes · thanks for your patience', MESSAGES.ja),
    '不鮮明なページを読み直し中 · これらのページの読み直しには2～4分かかる見込みです · お待たせしています',
  );
  assert.equal(translateKnown('Reading sheet music (page 2 of 5)', MESSAGES.ko), '악보 읽는 중 (5페이지 중 2페이지)');
});

test('server and upload errors are recognised, values carried through', () => {
  assert.equal(translateKnown('File must be at most 10 MB.', MESSAGES['zh-hant']), '檔案不能超過 10 MB。');
  assert.equal(translateKnown('Couldn\'t read IMG_0001.jpg.', MESSAGES.ko), 'IMG_0001.jpg을(를) 읽지 못했습니다.');
});

test('unrecognised text, and English, come back as they were', () => {
  assert.equal(translateKnown('Something new from the server.', MESSAGES.ja), 'Something new from the server.');
  assert.equal(translateKnown('Reading sheet music', en), 'Reading sheet music');
  assert.equal(translateKnown(null, MESSAGES.ja), '');
});
