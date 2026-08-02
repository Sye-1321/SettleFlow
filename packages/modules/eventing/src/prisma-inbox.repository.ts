import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import type {
  InboxMessageRecord,
  InboxRepository,
  InboxTransactionContext,
  ReserveInboxMessageInput,
} from './inbox.types';

interface InboxRow {
  readonly consumerName: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly messageId: string;
  readonly payloadSha256: Uint8Array;
  readonly schemaVersion: number;
}

interface ProjectionClockRow {
  readonly processedAt: Date;
}

export interface PrismaInboxRepositoryOptions {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly transactionTimeoutMs: number;
}

export class PrismaInboxRepository implements InboxRepository {
  public constructor(
    private readonly database: PrismaDatabase,
    private readonly options: PrismaInboxRepositoryOptions,
  ) {}

  public async withSerializableTransaction<T>(
    operation: (context: InboxTransactionContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true)`;
          await transaction.$queryRaw`SELECT set_config('statement_timeout', ${`${this.options.statementTimeoutMs}ms`}, true)`;
          const clock = await transaction.$queryRaw<ProjectionClockRow[]>`
            SELECT clock_timestamp() AS "processedAt"
          `;
          const processedAt = clock[0]?.processedAt;
          if (processedAt === undefined) {
            throw new Error('PostgreSQL did not return a projection timestamp');
          }
          return operation({ processedAt, transaction });
        },
        {
          isolationLevel: 'Serializable',
          maxWait: this.options.lockTimeoutMs,
          timeout: this.options.transactionTimeoutMs,
        },
      );
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async reserve(
    transaction: PrismaTransactionClient,
    input: ReserveInboxMessageInput,
  ): Promise<
    | { readonly kind: 'reserved' }
    | { readonly kind: 'existing'; readonly record: InboxMessageRecord }
  > {
    const inserted = await transaction.$queryRaw<{ readonly messageId: string }[]>`
      INSERT INTO "inbox_messages" (
        "consumer_name",
        "message_id",
        "event_type",
        "schema_version",
        "payload_sha256",
        "correlation_id",
        "received_at",
        "completed_at"
      )
      VALUES (
        ${input.consumerName},
        ${input.messageId},
        ${input.eventType},
        ${input.schemaVersion},
        ${input.payloadSha256},
        ${input.correlationId},
        ${input.receivedAt},
        ${input.completedAt}
      )
      ON CONFLICT ("consumer_name", "message_id") DO NOTHING
      RETURNING "message_id" AS "messageId"
    `;
    if (inserted.length === 1) {
      return { kind: 'reserved' };
    }

    const existing = await transaction.$queryRaw<InboxRow[]>`
      SELECT
        "consumer_name" AS "consumerName",
        "message_id" AS "messageId",
        "event_type" AS "eventType",
        "schema_version" AS "schemaVersion",
        "payload_sha256" AS "payloadSha256",
        "correlation_id" AS "correlationId"
      FROM "inbox_messages"
      WHERE "consumer_name" = ${input.consumerName}
        AND "message_id" = ${input.messageId}
    `;
    const record = existing[0];
    if (record === undefined) {
      throw new Error('Inbox conflict did not expose the existing completed message');
    }
    return { kind: 'existing', record };
  }
}
