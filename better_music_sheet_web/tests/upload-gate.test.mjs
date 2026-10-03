import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/upload-gate.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const api = load();

function subscription(overrides = {}) {
  return {
    tier: "free", plan: null, status: null, current_period_end: null,
    cancel_at_period_end: false, platform: null,
    ...overrides,
  };
}

const sheet = (status) => ({ status });

test('a premium account proceeds with the upload, however many sheets it has', () => {
  // Compared field by field, not via deepEqual on the whole object: the
  // result crosses the vm sandbox's realm boundary, where a strict deep
  // comparison sees a different Object prototype and fails on that alone.
  const result = api.resolveUploadAttempt(subscription({ tier: "premium", status: "active" }), [sheet("done"), sheet("done")]);
  assert.equal(result.proceed, true);
});

test('a free account with no sheet uploads', () => {
  assert.equal(api.resolveUploadAttempt(subscription({ tier: "free" }), []).proceed, true);
});

test('a free account that has a sheet is at its limit', () => {
  for (const status of ["done", "processing", "queued", "uploading"]) {
    const result = api.resolveUploadAttempt(subscription({ tier: "free" }), [sheet(status)]);
    assert.equal(result.proceed, false, status);
    assert.equal(result.reason, "free-limit", status);
  }
});

test('deleting the sheet lets a free account upload again', () => {
  // Once the sheet is gone (or going), the one slot is free again.
  assert.equal(api.resolveUploadAttempt(subscription({ tier: "free" }), [sheet("deleted")]).proceed, true);
  assert.equal(api.resolveUploadAttempt(subscription({ tier: "free" }), [sheet("deleting")]).proceed, true);
});

test('a failed sheet does not take up the free slot', () => {
  // The same rule as server.py's _check_free_sheet_limit.
  const result = api.resolveUploadAttempt(subscription({ tier: "free" }), [sheet("failed")]);
  assert.equal(result.proceed, true);
});

test('a canceled or expired premium status is treated the same as free', () => {
  // The backend's get_entitlement already folds a canceled/expired
  // subscription back to tier "free" - this just pins that this function
  // trusts the tier field alone, not status, plan, or platform.
  const result = api.resolveUploadAttempt(subscription({ tier: "free", status: "expired", plan: "monthly" }), [sheet("done")]);
  assert.equal(result.proceed, false);
});
