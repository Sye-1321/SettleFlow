import { InboxService } from '@settleflow/eventing';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
import type { PaymentSettlementReadPort } from '@settleflow/payments';

import { SettlementProjectionService } from './settlement-projection.service';
import type { SettlementRepository } from './settlement.types';

interface ProjectionHarness {
  readonly inbox: jest.Mocked<InboxService>;
  readonly payments: jest.Mocked<PaymentSettlementReadPort>;
  readonly projectLifecycle: jest.Mock;
  readonly repository: jest.Mocked<SettlementRepository>;
  readonly service: SettlementProjectionService;
}

describe('SettlementProjectionService', () => {
  const occurredAt = new Date('2026-08-03T10:00:00.000Z');
  const transaction = {} as PrismaTransactionClient;

  function harness(withInbox = true): ProjectionHarness {
    const projectLifecycle = jest.fn().mockResolvedValue(undefined);
    const repository = {
      projectLifecycle,
    } as unknown as jest.Mocked<SettlementRepository>;
    const identifiers = {
      generate: jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    } as unknown as jest.Mocked<MonotonicUlidGenerator>;
    const payments = {
      readSettlementProjectionIdentity: jest.fn().mockResolvedValue({
        currency: 'ETB',
        paymentIntentId: 'payment-internal',
        paymentPublicId: 'pi-id',
        refundRecordId: 'refund-internal',
      }),
    } as unknown as jest.Mocked<PaymentSettlementReadPort>;
    const inbox = {
      processForConsumer: jest.fn(),
    } as unknown as jest.Mocked<InboxService>;
    return {
      inbox,
      payments,
      projectLifecycle,
      repository,
      service: new SettlementProjectionService(
        repository,
        identifiers,
        payments,
        withInbox ? inbox : undefined,
      ),
    };
  }

  it('resolves capture and refund identities before projecting', async () => {
    const h = harness();
    await h.service.process(transaction, {
      amountMinor: 1_000,
      availableOn: occurredAt,
      currency: 'ETB',
      eventId: 'evt-capture',
      eventType: 'payment.captured.v1',
      merchantId: 'merchant',
      occurredAt,
      paymentId: 'pi-id',
    });
    await h.service.process(transaction, {
      amountMinor: 100,
      cumulativeRefundedAmountMinor: 100,
      currency: 'ETB',
      eventId: 'evt-refund',
      eventType: 'payment.refunded.v1',
      merchantId: 'merchant',
      occurredAt,
      paymentId: 'pi-id',
      refundId: 'rf-id',
    });
    expect(h.projectLifecycle).toHaveBeenNthCalledWith(
      2,
      transaction,
      expect.objectContaining({ refundRecordId: 'refund-internal' }),
      'sta_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
  });

  it('fails closed on missing, cross-currency, and unsupported identities', async () => {
    const h = harness();
    h.payments.readSettlementProjectionIdentity.mockResolvedValue(undefined);
    await expect(
      h.service.process(transaction, {
        amountMinor: 1,
        currency: 'ETB',
        eventId: 'evt',
        eventType: 'payment.captured.v1',
        merchantId: 'merchant',
        occurredAt,
        paymentId: 'pi-id',
      }),
    ).rejects.toThrow('payment_settlement_projection_identity_mismatch');
    const noInbox = harness(false);
    expect(() =>
      noInbox.service.handle({ event: { eventType: 'payment.captured.v1' } } as never),
    ).toThrow('Settlement inbox is not configured');
    expect(() => h.service.handle({ event: { eventType: 'payment.created.v1' } } as never)).toThrow(
      'Settlement projection does not consume payment.created.v1',
    );
  });
});
