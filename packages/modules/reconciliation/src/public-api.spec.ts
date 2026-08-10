import * as reconciliation from './index';

describe('reconciliation public API', () => {
  it('exposes import, classification, and persistence boundaries', () => {
    expect(Object.values(reconciliation).every((value) => value !== undefined)).toBe(true);
    expect(typeof reconciliation.ReconciliationService).toBe('function');
    expect(typeof reconciliation.PrismaReconciliationRepository).toBe('function');
  });
});
