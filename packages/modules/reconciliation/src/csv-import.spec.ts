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
