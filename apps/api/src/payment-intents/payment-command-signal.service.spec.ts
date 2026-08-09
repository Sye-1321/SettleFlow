import type { TelemetryRuntime } from '@settleflow/infrastructure';

import { PaymentCommandSignalService } from './payment-command-signal.service';

describe('PaymentCommandSignalService', () => {
  it('logs only the bounded observation supplied by Payments', () => {
    const record = jest.fn();
    const observation = {
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      merchantId: '11111111-1111-4111-8111-111111111111',
      operation: 'capture' as const,
      outcome: 'committed' as const,
      paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_observation',
    };

    const telemetry = { logger: { record } } as unknown as TelemetryRuntime;
    new PaymentCommandSignalService(telemetry).record(observation);

    expect(record).toHaveBeenCalledWith('info', { event: 'payment.command', ...observation });
  });
});
