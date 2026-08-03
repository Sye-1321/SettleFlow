import { InboxService, type ValidatedPaymentEventMessage } from '@settleflow/eventing';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
import type { PaymentSettlementReadPort } from '@settleflow/payments';

import type { SettlementProjectionEvent, SettlementRepository } from './settlement.types';

export class SettlementProjectionService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly payments: PaymentSettlementReadPort,
    private readonly inbox?: InboxService,
  ) {}

  public async process(
    transaction: PrismaTransactionClient,
    event: SettlementProjectionEvent,
  ): Promise<void> {
    const identity = await this.payments.readSettlementProjectionIdentity(
      transaction,
      event.merchantId,
      event.paymentId,
      event.refundId,
    );
    if (identity?.currency !== event.currency)
      throw new Error('payment_settlement_projection_identity_mismatch');
    const adjustmentId =
      event.eventType === 'payment.refunded.v1'
        ? `sta_${this.identifiers.generate(event.occurredAt.getTime())}`
        : undefined;
    await this.repository.projectLifecycle(
      transaction,
      {
        ...event,
        paymentIntentId: identity.paymentIntentId,
        ...(identity.refundRecordId === undefined
          ? {}
          : { refundRecordId: identity.refundRecordId }),
      },
      adjustmentId,
    );
  }

  public handle(message: ValidatedPaymentEventMessage): Promise<{
    readonly kind: 'duplicate' | 'processed';
    readonly value?: { readonly alreadyProjected: boolean; readonly deliveryCount: number };
  }> {
    if (message.event.eventType === 'payment.created.v1')
      throw new Error('Settlement projection does not consume payment.created.v1');
    const name = `settlement-projection.${message.event.eventType.replace('payment.', 'payment-')}`;
    if (this.inbox === undefined) throw new Error('Settlement inbox is not configured');
    return this.inbox.processForConsumer(message, name, async (context, validated) => {
      const event = (validated as ValidatedPaymentEventMessage).event;
      if (event.eventType === 'payment.created.v1')
        throw new Error('Unsupported settlement lifecycle event');
      await this.process(context.transaction, {
        amountMinor:
          event.eventType === 'payment.captured.v1' ? event.capturedAmountMinor : event.amountMinor,
        currency: event.currency,
        ...(event.eventType === 'payment.captured.v1'
          ? { availableOn: event.availableOn }
          : {
              cumulativeRefundedAmountMinor: event.cumulativeRefundedAmountMinor,
              refundId: event.refundId,
            }),
        eventId: event.eventId,
        eventType: event.eventType,
        merchantId: event.merchantId,
        occurredAt: event.occurredAt,
        paymentId: event.paymentId,
      });
      return { alreadyProjected: false, deliveryCount: 0 };
    });
  }
}
