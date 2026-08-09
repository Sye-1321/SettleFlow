import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkMarkdownLinks, markdownAnchors, markdownTargets } from './check-markdown-links.mjs';
import { parseEnvironmentExample } from './check-config.mjs';
import { checkContracts } from './check-contracts.mjs';
import { checkCoverage } from './check-coverage.mjs';
import { checkModuleBoundaries } from './check-module-boundaries.mjs';

test('Markdown link parser ignores fenced examples and validates local anchors', () => {
  const root = mkdtempSync(join(tmpdir(), 'settleflow-quality-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'README.md'),
    '[Guide](docs/guide.md#safe-heading)\n```md\n[ignored](missing.md)\n```\n',
  );
  writeFileSync(join(root, 'docs/guide.md'), '# Safe heading\n');
  assert.deepEqual(checkMarkdownLinks(root, ['README.md', 'docs/guide.md']), []);
  assert.deepEqual(markdownTargets('[one](path.md)\n```\n[two](no.md)\n```'), ['path.md']);
  assert(markdownAnchors('# Same\n# Same').has('same-1'));
});

test('environment examples reject duplicate keys', () => {
  assert.deepEqual(parseEnvironmentExample('NODE_ENV=test\nPORT=3000\n'), {
    NODE_ENV: 'test',
    PORT: '3000',
  });
  assert.throws(() => parseEnvironmentExample('PORT=1\nPORT=2\n'), /Duplicate/u);
});

test('module-boundary checker rejects undeclared workspace and telemetry-vendor imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'settleflow-boundaries-'));
  mkdirSync(join(root, 'packages/example/src'), { recursive: true });
  writeFileSync(
    join(root, 'packages/example/package.json'),
    JSON.stringify({ dependencies: {}, name: '@settleflow/example' }),
  );
  writeFileSync(
    join(root, 'packages/example/src/index.ts'),
    "import '@settleflow/ledger';\nimport 'prom-client';\n",
  );
  assert.deepEqual(
    checkModuleBoundaries(root, ['packages/example/package.json', 'packages/example/src/index.ts']),
    [
      'packages/example/src/index.ts: undeclared cross-module import @settleflow/ledger',
      'packages/example/src/index.ts: telemetry vendor import prom-client is Infrastructure-owned',
    ],
  );
});

test('contract checker accepts strict /v1 OpenAPI and closed event bodies', () => {
  const root = mkdtempSync(join(tmpdir(), 'settleflow-contracts-'));
  mkdirSync(join(root, 'docs/api'), { recursive: true });
  mkdirSync(join(root, 'docs/events'), { recursive: true });
  writeFileSync(
    join(root, 'docs/api/openapi.json'),
    JSON.stringify({
      openapi: '3.0.0',
      paths: { '/v1/example': { get: { operationId: 'Example_get' } } },
    }),
  );
  writeFileSync(
    join(root, 'docs/events/example.v1.schema.json'),
    JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: { eventType: { const: 'example.v1' } },
      required: ['eventType'],
      title: 'example.v1',
      type: 'object',
    }),
  );
  assert.deepEqual(checkContracts(root), []);
});

test('coverage checker aggregates a critical bounded module before applying thresholds', () => {
  const covered = coverageFile({ branches: [1, 1], functions: [1], statements: [1, 1] });
  const uncovered = coverageFile({ branches: [0], functions: [0], statements: [0] });
  const result = checkCoverage({
    'C:/repo/packages/modules/eventing/src/covered.ts': covered,
    'C:/repo/packages/modules/eventing/src/uncovered.ts': uncovered,
  });
  assert.equal(result.results.eventing.statements.percentage, 66.66666666666666);
  assert(result.failures.includes('eventing statements: 66.67% is below 90%'));
  assert(!result.failures.some((failure) => failure.includes('covered.ts')));
});

function coverageFile({ branches, functions, statements }) {
  return {
    b: { 0: branches },
    f: Object.fromEntries(functions.map((hits, index) => [index, hits])),
    s: Object.fromEntries(statements.map((hits, index) => [index, hits])),
    statementMap: Object.fromEntries(
      statements.map((_, index) => [index, { start: { line: index + 1 } }]),
    ),
  };
}
