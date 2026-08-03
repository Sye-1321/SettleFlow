import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import { AuditService, InvalidAuditRecordError } from './audit.service';
import type { AuditRepository } from './operations.types';

describe('AuditService', () => {
  it('appends an allowlisted webhook lifecycle record through the transaction port', async () => {
    const appendWebhookLifecycle = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({
      appendOperational: jest.fn(),
      appendWebhookLifecycle,
    } satisfies AuditRepository);
    const transaction = {} as PrismaTransactionClient;
    const input = {
      action: 'webhook_endpoint.created' as const,
      actorApiKeyId: '00000000-0000-4000-8000-000000000002',
      details: {
        status: 'active' as const,
        subscriptions: ['payment.created.v1'] as const,
        version: 0 as const,
      },
      merchantId: '00000000-0000-4000-8000-000000000001',
      occurredAt: new Date('2026-08-01T12:00:00.000Z'),
      requestId: 'req_audit_test',
      targetId: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    };

    await service.appendWebhookLifecycle(transaction, input);

    expect(appendWebhookLifecycle).toHaveBeenCalledWith(transaction, input);
  });

  it('rejects unsafe actor, target, request, and time values before persistence', async () => {
    const appendWebhookLifecycle = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({
      appendOperational: jest.fn(),
      appendWebhookLifecycle,
    } satisfies AuditRepository);

    await expect(
      service.appendWebhookLifecycle({} as PrismaTransactionClient, {
        action: 'webhook_endpoint.secret_rotated',
        actorApiKeyId: 'not-a-uuid',
        details: { changedFields: ['secret'], version: 1 },
        merchantId: '00000000-0000-4000-8000-000000000001',
        occurredAt: new Date(Number.NaN),
        requestId: 'bad request id',
        targetId: 'whe_invalid',
      }),
    ).rejects.toBeInstanceOf(InvalidAuditRecordError);
    expect(appendWebhookLifecycle).not.toHaveBeenCalled();
  });
});
