import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CRITICAL_MODULES = [
  'eventing',
  'idempotency',
  'ledger',
  'payments',
  'reconciliation',
  'settlements',
  'webhooks',
];

const APPROVED_THRESHOLDS = {
  critical: { branches: 85, functions: 85, lines: 90, statements: 90 },
  global: { branches: 80, functions: 80, lines: 85, statements: 85 },
};

export function checkCoverage(coverage) {
  const entries = Object.entries(coverage);
  const groups = [['global', entries]];
  for (const moduleName of CRITICAL_MODULES) {
    const marker = `/packages/modules/${moduleName}/src/`;
    groups.push([
      moduleName,
      entries.filter(([file]) => file.replaceAll('\\', '/').includes(marker)),
    ]);
  }

  const failures = [];
  const results = {};
  for (const [name, files] of groups) {
    if (files.length === 0) {
      failures.push(`${name}: no instrumented files found`);
      continue;
    }
    const summary = summarize(files.map((entry) => entry[1]));
    results[name] = summary;
    const thresholds =
      name === 'global' ? APPROVED_THRESHOLDS.global : APPROVED_THRESHOLDS.critical;
    for (const metric of ['statements', 'branches', 'functions', 'lines']) {
      if (summary[metric].percentage < thresholds[metric]) {
        failures.push(
          `${name} ${metric}: ${format(summary[metric].percentage)}% is below ${thresholds[metric]}%`,
        );
      }
    }
  }
  return { failures, results };
}

function summarize(files) {
  const totals = {
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
    statements: { covered: 0, total: 0 },
  };
  for (const file of files) {
    addHits(totals.statements, Object.values(file.s));
    addHits(totals.functions, Object.values(file.f));
    addHits(totals.branches, Object.values(file.b).flat());
    const lineHits = new Map();
    for (const [statementId, hits] of Object.entries(file.s)) {
      const line = file.statementMap[statementId].start.line;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }
    addHits(totals.lines, [...lineHits.values()]);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([metric, value]) => [
      metric,
      {
        ...value,
        percentage: value.total === 0 ? 100 : (value.covered / value.total) * 100,
      },
    ]),
  );
}

function addHits(total, hits) {
  total.total += hits.length;
  total.covered += hits.filter((count) => count > 0).length;
}

function format(value) {
  return value.toFixed(2).replace(/\.00$/u, '');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const coveragePath = resolve(process.cwd(), 'coverage/coverage-final.json');
  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const result = checkCoverage(coverage);
  for (const [name, summary] of Object.entries(result.results)) {
    process.stdout.write(
      `${name}: ${['statements', 'branches', 'functions', 'lines']
        .map((metric) => `${metric} ${format(summary[metric].percentage)}%`)
        .join(', ')}\n`,
    );
  }
  if (result.failures.length > 0) {
    process.stderr.write(`${result.failures.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Approved coverage thresholds passed.\n');
}

export const coverageInternals = { APPROVED_THRESHOLDS, CRITICAL_MODULES };
