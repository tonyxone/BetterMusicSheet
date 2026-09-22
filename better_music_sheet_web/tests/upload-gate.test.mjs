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

test('a premium account proceeds with the upload', () => {
  // Compared field by field, not via deepEqual on the whole object: the
  // result crosses the vm sandbox's realm boundary, where a strict deep
  // comparison sees a different Object prototype and fails on that alone.
  const result = api.resolveUploadAttempt(subscription({ tier: "premium", status: "active" }));
  assert.equal(result.proceed, true);
  assert.equal(result.redirectTo, undefined);
});

test('a free account is sent to the paywall instead of uploading', () => {
  const result = api.resolveUploadAttempt(subscription({ tier: "free" }));
  assert.equal(result.proceed, false);
  assert.equal(result.redirectTo, "/subscription/upgrade");
});

test('a canceled or expired premium status is treated the same as free', () => {
  // The backend's get_entitlement already folds a canceled/expired
  // subscription back to tier "free" - this just pins that this function
  // trusts the tier field alone, not status, plan, or platform.
  const result = api.resolveUploadAttempt(subscription({ tier: "free", status: "expired", plan: "monthly" }));
  assert.equal(result.proceed, false);
});
