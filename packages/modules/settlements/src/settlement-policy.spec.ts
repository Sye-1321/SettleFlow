import { SettlementCutoffNotClosedError } from './settlement.errors';
import { calculateFee, cutoffInstant } from './settlement-policy';

describe('settlement policy', () => {
  it('uses the approved flat fee plus floor-rounded 200 basis points', () => {
    expect(calculateFee(120_000n, 'ETB')).toEqual({
      basisPoints: 200,
      feeMinor: 3_000n,
      flatFeeMinor: 600n,
    });
    expect(calculateFee(10_001n, 'USD')).toEqual({
      basisPoints: 200,
      feeMinor: 225n,
      flatFeeMinor: 25n,
    });
  });

  it('closes an Addis Ababa business date at the exclusive next local midnight', () => {
    expect(cutoffInstant('2026-08-01', new Date('2026-08-01T21:00:00.000Z')).toISOString()).toBe(
      '2026-08-01T21:00:00.000Z',
    );
    expect(() => cutoffInstant('2026-08-01', new Date('2026-08-01T20:59:59.999Z'))).toThrow(
      SettlementCutoffNotClosedError,
    );
  });
});
