import type { PrismaTransactionClient } from '@settleflow/infrastructure';

export type WebhookLifecycleAuditAction =
  | 'webhook_endpoint.created'
  | 'webhook_endpoint.secret_rotated'
  | 'webhook_endpoint.status_changed'
  | 'webhook_endpoint.subscriptions_changed';

export type WebhookLifecycleAuditDetails =
  | {
      readonly status: 'active';
      readonly subscriptions: readonly (
        'payment.captured.v1' | 'payment.created.v1' | 'payment.refunded.v1'
      )[];
      readonly version: 0;
    }
  | {
      readonly changedFields: readonly ['secret'];
      readonly version: number;
    }
  | {
      readonly from: 'active' | 'inactive';
      readonly to: 'active' | 'inactive';
      readonly version: number;
    }
  | {
      readonly from: readonly (
        'payment.captured.v1' | 'payment.created.v1' | 'payment.refunded.v1'
      )[];
      readonly to: readonly (
        'payment.captured.v1' | 'payment.created.v1' | 'payment.refunded.v1'
      )[];
      readonly version: number;
    };

export interface AppendWebhookLifecycleAuditInput {
  readonly action: WebhookLifecycleAuditAction;
  readonly actorApiKeyId: string;
  readonly details: WebhookLifecycleAuditDetails;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly targetId: string;
}

export interface AuditRepository {
  appendWebhookLifecycle(
    transaction: PrismaTransactionClient,
    input: AppendWebhookLifecycleAuditInput,
  ): Promise<void>;
}
