import { parseReconciliationCsv } from './csv-import';
import {
  ReconciliationCsvInvalidError,
  ReconciliationFileTooLargeError,
  ReconciliationRowLimitExceededError,
} from './reconciliation.errors';

const header =
  'provider_txn_id,merchant_code,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at\r\n';
const validRow =
  'txn_1,merchant_a,ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV,,capture,ETB,120000,0,120000,succeeded,2026-08-02T10:20:12.345Z\r\n';

describe('reconciliation CSV boundary', () => {
  it('parses the exact approved header and integer-minor-unit row', async () => {
    const rows = await parseReconciliationCsv(
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV,,capture,ETB,120000,0,120000,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    );
    expect(rows).toEqual([
      expect.objectContaining({ grossMinor: 120_000n, merchantCode: 'merchant_a', rowNumber: 1 }),
    ]);
  });

  it('rejects arithmetic disagreement', async () => {
    await expect(
      parseReconciliationCsv(
        Buffer.from(
          `${header}txn_1,merchant_a,ltx_1,,capture,ETB,100,1,100,succeeded,2026-08-02T10:20:12.345Z\r\n`,
        ),
      ),
    ).rejects.toBeInstanceOf(ReconciliationCsvInvalidError);
  });

  it('rejects a BOM, unsafe integer, and non-canonical header', async () => {
    const invalid = [
      Buffer.from(
        `\uFEFF${header}txn_1,merchant_a,ltx_1,,capture,ETB,100,0,100,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,capture,ETB,9007199254740992,0,9007199254740992,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
      Buffer.from(
        `merchant_code,provider_txn_id,provider_ref,external_ref,event_type,currency,gross_minor,fee_minor,net_minor,status,occurred_at\r\nmerchant_a,txn_1,ltx_1,,capture,ETB,100,0,100,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ];
    for (const bytes of invalid) {
      await expect(parseReconciliationCsv(bytes)).rejects.toBeInstanceOf(
        ReconciliationCsvInvalidError,
      );
    }
  });

  it('accepts settlement arithmetic and every supported event, currency, and status value', async () => {
    const rows = await parseReconciliationCsv(
      Buffer.from(
        header +
          [
            'txn_1,merchant_a,ltx_1,,capture,ETB,100,0,100,succeeded,2026-08-02T10:20:12.345Z',
            'txn_2,merchant_a,ltx_2,,refund,USD,20,0,20,failed,2026-08-02T10:20:12.345Z',
            'txn_3,merchant_a,ltx_3,,settlement,ETB,100,5,95,succeeded,2026-08-02T10:20:12.345Z',
            'txn_4,merchant_a,ltx_4,sta_1,adjustment,USD,7,0,7,succeeded,2026-08-02T10:20:12.345Z',
            '',
          ].join('\r\n'),
      ),
    );
    expect(
      rows.map(({ currency, eventType, status }) => ({ currency, eventType, status })),
    ).toEqual([
      { currency: 'ETB', eventType: 'capture', status: 'succeeded' },
      { currency: 'USD', eventType: 'refund', status: 'failed' },
      { currency: 'ETB', eventType: 'settlement', status: 'succeeded' },
      { currency: 'USD', eventType: 'adjustment', status: 'succeeded' },
    ]);
  });

  it.each([
    ['empty input', Buffer.alloc(0)],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['header without rows', Buffer.from(header)],
    ['wrong column count', Buffer.from(`${header}txn_1,merchant_a\r\n`)],
    [
      'negative money',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,capture,ETB,-1,0,0,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'unsupported event',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,payout,ETB,1,0,1,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'unsupported currency',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,capture,EUR,1,0,1,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'unsupported status',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,capture,ETB,1,0,1,pending,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'invalid settlement arithmetic',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,settlement,ETB,100,5,96,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'noncanonical timestamp',
      Buffer.from(
        `${header}txn_1,merchant_a,ltx_1,,capture,ETB,1,0,1,succeeded,2026-08-02T10:20:12Z\r\n`,
      ),
    ],
    [
      'control character',
      Buffer.from(
        `${header}txn_1,merchant_${String.fromCharCode(1)},ltx_1,,capture,ETB,1,0,1,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
    [
      'overlong identifier',
      Buffer.from(
        `${header}${'x'.repeat(256)},merchant_a,ltx_1,,capture,ETB,1,0,1,succeeded,2026-08-02T10:20:12.345Z\r\n`,
      ),
    ],
  ])('rejects %s', async (_case, bytes) => {
    await expect(parseReconciliationCsv(bytes)).rejects.toBeInstanceOf(
      ReconciliationCsvInvalidError,
    );
  });

  it('rejects input above the exact 10 MiB boundary before parsing', async () => {
    await expect(parseReconciliationCsv(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(
      ReconciliationFileTooLargeError,
    );
  });

  it('accepts exactly 50,000 rows and rejects the next row', async () => {
    await expect(
      parseReconciliationCsv(Buffer.from(header + validRow.repeat(50_000))),
    ).resolves.toHaveLength(50_000);
    await expect(
      parseReconciliationCsv(Buffer.from(header + validRow.repeat(50_001))),
    ).rejects.toBeInstanceOf(ReconciliationRowLimitExceededError);
  }, 15_000);
});
