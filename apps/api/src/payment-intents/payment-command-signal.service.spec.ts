import { Logger } from '@nestjs/common';

import { PaymentCommandSignalService } from './payment-command-signal.service';

describe('PaymentCommandSignalService', () => {
  it('logs only the bounded observation supplied by Payments', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const observation = {
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      merchantId: '11111111-1111-4111-8111-111111111111',
      operation: 'capture' as const,
      outcome: 'committed' as const,
      paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_observation',
    };

    new PaymentCommandSignalService().record(observation);

    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'payment.command', ...observation }));
  });
});
