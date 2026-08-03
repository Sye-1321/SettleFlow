import { Readable } from 'node:stream';
import { parse } from 'csv-parse';

import {
  ReconciliationCsvInvalidError,
  ReconciliationFileTooLargeError,
  ReconciliationRowLimitExceededError,
} from './reconciliation.errors';
import type { ParsedProviderRow, ReconciliationEventType } from './reconciliation.types';

export const RECONCILIATION_HEADERS = [
  'provider_txn_id',
  'merchant_code',
  'provider_ref',
  'external_ref',
  'event_type',
  'currency',
  'gross_minor',
  'fee_minor',
  'net_minor',
  'status',
  'occurred_at',
] as const;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function bounded(value: unknown, optional = false): string | undefined {
  if (
    typeof value !== 'string' ||
    (!optional && value.length === 0) ||
    [...value].length > 255 ||
    /[\p{Cc}]/u.test(value)
  )
    throw new ReconciliationCsvInvalidError();
  return value.length === 0 && optional ? undefined : value;
}
function money(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value))
    throw new ReconciliationCsvInvalidError();
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_SAFE) throw new ReconciliationCsvInvalidError();
  return parsed;
}

export async function parseReconciliationCsv(bytes: Buffer): Promise<readonly ParsedProviderRow[]> {
  if (bytes.length < 1) throw new ReconciliationCsvInvalidError();
  if (bytes.length > 10 * 1024 * 1024) throw new ReconciliationFileTooLargeError();
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new ReconciliationCsvInvalidError();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReconciliationCsvInvalidError();
  }
  const parser = parse({
    bom: false,
    columns: (headers: string[]) => {
      if (
        headers.length !== RECONCILIATION_HEADERS.length ||
        headers.some((header, index) => header !== RECONCILIATION_HEADERS[index])
      ) {
        throw new ReconciliationCsvInvalidError();
      }
      return headers;
    },
    delimiter: ',',
    max_record_size: 16 * 1024,
    record_delimiter: ['\r\n', '\n'],
    relax_column_count: false,
    skip_empty_lines: false,
    trim: false,
  });
  Readable.from([text]).pipe(parser);
  const rows: ParsedProviderRow[] = [];
  try {
    for await (const unknownRow of parser) {
      if (rows.length >= 50_000) throw new ReconciliationRowLimitExceededError();
      if (typeof unknownRow !== 'object' || unknownRow === null || Array.isArray(unknownRow))
        throw new ReconciliationCsvInvalidError();
      const row = unknownRow as Record<string, unknown>;
      if (
        Object.keys(row).length !== RECONCILIATION_HEADERS.length ||
        RECONCILIATION_HEADERS.some((header) => !(header in row))
      )
        throw new ReconciliationCsvInvalidError();
      const grossMinor = money(row['gross_minor']);
      const feeMinor = money(row['fee_minor']);
      const netMinor = money(row['net_minor']);
      const eventType = row['event_type'];
      const currency = row['currency'];
      const status = row['status'];
      if (
        !['capture', 'refund', 'settlement', 'adjustment'].includes(String(eventType)) ||
        (currency !== 'ETB' && currency !== 'USD') ||
        (status !== 'succeeded' && status !== 'failed')
      )
        throw new ReconciliationCsvInvalidError();
      if (
        eventType === 'settlement'
          ? grossMinor !== feeMinor + netMinor
          : feeMinor !== 0n || netMinor !== grossMinor
      )
        throw new ReconciliationCsvInvalidError();
      const occurredAt = new Date(String(row['occurred_at']));
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(String(row['occurred_at'])) ||
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.toISOString() !== row['occurred_at']
      )
        throw new ReconciliationCsvInvalidError();
      rows.push({
        currency,
        eventType: eventType as ReconciliationEventType,
        externalRef: bounded(row['external_ref'], true),
        feeMinor,
        grossMinor,
        merchantCode: bounded(row['merchant_code'])!,
        netMinor,
        occurredAt,
        providerRef: bounded(row['provider_ref'])!,
        providerTransactionId: bounded(row['provider_txn_id'])!,
        rowNumber: rows.length + 1,
        status,
      });
    }
  } catch (error: unknown) {
    if (
      error instanceof ReconciliationCsvInvalidError ||
      error instanceof ReconciliationRowLimitExceededError
    )
      throw error;
    throw new ReconciliationCsvInvalidError();
  }
  if (rows.length === 0) throw new ReconciliationCsvInvalidError();
  return rows;
}
