import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type { AppendWebhookLifecycleAuditInput, AuditRepository } from './operations.types';

export class PrismaAuditRepository implements AuditRepository {
  public async appendWebhookLifecycle(
    transaction: PrismaTransactionClient,
    input: AppendWebhookLifecycleAuditInput,
  ): Promise<void> {
    await transaction.auditEvent.create({
      data: {
        action: input.action,
        actorApiKeyId: input.actorApiKeyId,
        actorType: 'merchant_api_key',
        details: input.details,
        merchantId: input.merchantId,
        occurredAt: input.occurredAt,
        reason: 'merchant_api_request',
        requestId: input.requestId,
        targetId: input.targetId,
        targetType: 'webhook_endpoint',
      },
      select: { id: true },
    });
  }
}
