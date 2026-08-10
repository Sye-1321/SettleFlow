import * as settlements from './index';

describe('settlements public API', () => {
  it('exposes settlement orchestration and projection boundaries', () => {
    expect(Object.values(settlements).every((value) => value !== undefined)).toBe(true);
    expect(typeof settlements.SettlementProjectionService).toBe('function');
    expect(typeof settlements.SettlementService).toBe('function');
  });
});
