import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(clientApiFetch, fetch) {
  const source = fs.readFileSync(new URL('../lib/sheet-files.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({ clientApiFetch }), fetch, FormData, Response });
  return exports;
}

test('artifact bytes go directly to S3 without application credentials', async () => {
  const app = [], direct = [];
  const api = load(async (...args) => { app.push(args); return Response.json({ direct: true, pdf: 'https://s3.test/signed', timeline: null }); },
    async (...args) => { direct.push(args); return new Response('pdf'); });
  assert.equal(await (await api.fetchSheetFile('abc', 'pdf')).text(), 'pdf');
  assert.equal(app[0][0], '/api/sheets/abc/assets');
  assert.equal(direct[0][0], 'https://s3.test/signed');
  assert.equal(direct[0][1].credentials, 'omit');
  assert.equal(direct[0][1].headers, undefined);
});

test('old API and local storage remain readable during migration', async () => {
  const paths = [];
  const api = load(async (path) => { paths.push(path); return paths.length === 1 ? new Response('', { status: 404 }) : new Response('old'); },
    () => { throw new Error('must not send local request to S3'); });
  assert.equal(await (await api.fetchSheetFile('old', 'timeline')).text(), 'old');
  assert.equal(paths[1], '/api/sheets/old/timeline');
});

test('missing optional timeline is a 404 and does not fetch a null URL', async () => {
  const api = load(async () => Response.json({ direct: true, pdf: 'url', timeline: null }), () => { throw new Error('no fetch expected'); });
  assert.equal((await api.fetchSheetFile('a', 'timeline')).status, 404);
});

test('direct upload sends signed fields before file and tolerates lost completion response', async () => {
  const paths = [], transfers = [];
  const api = load(async (path) => {
    paths.push(path);
    if (path.endsWith('/complete')) throw new Error('browser disconnected');
    return Response.json({ job_id: 'a', upload: { url: 'https://s3.test', fields: { key: 'jobs/a/input', policy: 'signed' } } });
  }, async (url, options) => { transfers.push([url, options]); return new Response(null, { status: 204 }); });
  const job = await api.uploadSheet(new File(['pdf'], '夏日.pdf', { type: 'application/pdf' }), { dpi: 300 });
  assert.equal(job, 'a');
  assert.deepEqual([...transfers[0][1].body.keys()], ['key', 'policy', 'file']);
  assert.equal(transfers[0][1].headers, undefined);
  assert.equal(paths[1], '/api/uploads/a/complete');
});

test('invalid upload options render a readable validation error', async () => {
  const api = load(async () => Response.json({ detail: [{ msg: 'invalid dpi' }] }, { status: 422 }), () => {});
  await assert.rejects(api.uploadSheet(new File(['pdf'], 'a.pdf'), { dpi: 600 }), /Check the file and options/);
});
