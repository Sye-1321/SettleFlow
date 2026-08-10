import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCoverageRecords } from './run-coverage.mjs';

function record(statement, branch, fn) {
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
  return {
    path: 'module.ts',
    statementMap: { 0: location },
    fnMap: { 0: { name: 'fn', decl: location, loc: location, line: 1 } },
    branchMap: { 0: { type: 'if', line: 1, locations: [location, location] } },
    s: { 0: statement },
    f: { 0: fn },
    b: { 0: branch },
  };
}

test('merges counters without changing instrumentation maps', () => {
  const merged = mergeCoverageRecords(record(1, [1, 0], 0), record(2, [0, 3], 4));
  assert.deepEqual(merged.s, { 0: 3 });
  assert.deepEqual(merged.b, { 0: [1, 3] });
  assert.deepEqual(merged.f, { 0: 4 });
});

test('rejects incompatible shard instrumentation', () => {
  const right = record(1, [1, 1], 1);
  right.statementMap[0].start.line = 2;
  assert.throws(() => mergeCoverageRecords(record(1, [1, 1], 1), right), /instrumentation differs/);
});
