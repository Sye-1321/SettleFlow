import { Buffer } from 'node:buffer';

import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  AppendOperationalAuditInput,
  AppendWebhookLifecycleAuditInput,
  AuditRepository,
} from './operations.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const WEBHOOK_ID_PATTERN = /^whe_[0-9A-HJKMNP-TV-Z]{26}$/u;
const OPERATIONAL_ID_PATTERN = /^(rec|str)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export class InvalidAuditRecordError extends Error {
  public constructor() {
    super('The lifecycle audit record is invalid');
    this.name = 'InvalidAuditRecordError';
  }
}

function validate(input: AppendWebhookLifecycleAuditInput): void {
  const details = JSON.stringify(input.details);
  if (
    !UUID_PATTERN.test(input.merchantId) ||
    !UUID_PATTERN.test(input.actorApiKeyId) ||
    !WEBHOOK_ID_PATTERN.test(input.targetId) ||
    !REQUEST_ID_PATTERN.test(input.requestId) ||
    !Number.isFinite(input.occurredAt.getTime()) ||
    Buffer.byteLength(details, 'utf8') > 4_096
  ) {
    throw new InvalidAuditRecordError();
  }
}

export class AuditService {
  public constructor(private readonly repository: AuditRepository) {}

  public async appendWebhookLifecycle(
    transaction: PrismaTransactionClient,
    input: AppendWebhookLifecycleAuditInput,
  ): Promise<void> {
    validate(input);
    await this.repository.appendWebhookLifecycle(transaction, input);
  }

  public async appendOperational(
    transaction: PrismaTransactionClient,
    input: AppendOperationalAuditInput,
  ): Promise<void> {
    const details = JSON.stringify(input.details);
    if (
      !UUID_PATTERN.test(input.merchantId) ||
      !UUID_PATTERN.test(input.actorApiKeyId) ||
      !OPERATIONAL_ID_PATTERN.test(input.targetId) ||
      !REQUEST_ID_PATTERN.test(input.requestId) ||
      !Number.isFinite(input.occurredAt.getTime()) ||
      Buffer.byteLength(details, 'utf8') > 4_096 ||
      (input.targetType === 'settlement_run') !== (input.action === 'settlement.run_executed')
    )
      throw new InvalidAuditRecordError();
    await this.repository.appendOperational(transaction, input);
  }
}

export const auditServiceInternals = { validate };
