import * as payments from './index';

describe('payments public API', () => {
  it('exposes payment orchestration and its closed error vocabulary', () => {
    expect(Object.values(payments).every((value) => value !== undefined)).toBe(true);
    expect(typeof payments.PaymentIntentService).toBe('function');
    expect(typeof payments.PrismaPaymentIntentRepository).toBe('function');
  });
});
