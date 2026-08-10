import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIELDS = [
  'affectedArtifact',
  'approvedAt',
  'approvedBy',
  'compensatingControls',
  'expiresAt',
  'findingId',
  'owner',
  'rationale',
  'severity',
  'tool',
];

const SAFE_TEXT = /^[\x20-\x7e]{1,512}$/u;

export function validateSecurityExceptions(document, now = new Date()) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    throw new Error('Security exceptions must use schemaVersion 1 and an exceptions array');
  }
  const keys = Object.keys(document).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['exceptions', 'schemaVersion'])) {
    throw new Error('Security exception document contains unsupported fields');
  }
  const seen = new Set();
  for (const exception of document.exceptions) {
    const fields = Object.keys(exception).sort();
    if (JSON.stringify(fields) !== JSON.stringify([...REQUIRED_FIELDS].sort())) {
      throw new Error('A security exception has missing or unsupported fields');
    }
    if (exception.severity !== 'high') {
      throw new Error('Only high findings may be excepted; critical findings always block');
    }
    for (const field of [
      'affectedArtifact',
      'approvedBy',
      'findingId',
      'owner',
      'rationale',
      'tool',
    ]) {
      if (typeof exception[field] !== 'string' || !SAFE_TEXT.test(exception[field])) {
        throw new Error(`Security exception ${field} must be bounded printable text`);
      }
    }
    if (
      !Array.isArray(exception.compensatingControls) ||
      exception.compensatingControls.length === 0 ||
      exception.compensatingControls.some(
        (control) => typeof control !== 'string' || !SAFE_TEXT.test(control),
      )
    ) {
      throw new Error('Security exceptions require bounded compensating controls');
    }
    const approvedAt = new Date(exception.approvedAt);
    const expiresAt = new Date(exception.expiresAt);
    if (Number.isNaN(approvedAt.valueOf()) || Number.isNaN(expiresAt.valueOf())) {
      throw new Error('Security exception dates must be valid ISO timestamps');
    }
    const duration = expiresAt.valueOf() - approvedAt.valueOf();
    if (duration <= 0 || duration > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('Security exceptions must expire within 30 days of approval');
    }
    if (expiresAt.valueOf() <= now.valueOf()) {
      throw new Error(`Security exception ${exception.findingId} is expired`);
    }
    const identity = `${exception.tool}\u0000${exception.findingId}\u0000${exception.affectedArtifact}`;
    if (seen.has(identity)) throw new Error('Duplicate security exception identity');
    seen.add(identity);
  }
  return document.exceptions;
}

export function readSecurityExceptions(root = process.cwd(), now = new Date()) {
  const document = JSON.parse(readFileSync(resolve(root, 'security/exceptions.json'), 'utf8'));
  return validateSecurityExceptions(document, now);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const exceptions = readSecurityExceptions();
  process.stdout.write(
    `Security exception policy passed (${exceptions.length} active exception${exceptions.length === 1 ? '' : 's'}).\n`,
  );
}
