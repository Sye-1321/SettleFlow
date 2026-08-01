import { PrismaDatabase } from '@settleflow/infrastructure';

import type {
  ClaimedOutboxEvent,
  ClaimPendingOutboxInput,
  FinalizeOutboxInput,
  FinalizeOutboxResult,
  OutboxRelayRepository,
  OutboxRelaySignalSink,
} from './outbox-relay.types';

interface ClaimRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly attempt_count: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly id: string;
  readonly merchant_id: string;
  readonly occurred_at: Date;
  readonly payload: unknown;
  readonly request_id: string;
}

export interface PrismaOutboxRelayRepositoryOptions {
  readonly leaseDurationMs: number;
  readonly signal?: OutboxRelaySignalSink;
  readonly transactionTimeoutMs: number;
}

export class PrismaOutboxRelayRepository implements OutboxRelayRepository {
  public constructor(
    private readonly database: PrismaDatabase,
    private readonly options: PrismaOutboxRelayRepositoryOptions,
  ) {}

  public async claimPending(
    input: ClaimPendingOutboxInput,
  ): Promise<readonly ClaimedOutboxEvent[]> {
    const startedAt = performance.now();
    try {
      const rows = await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT set_config(
              'statement_timeout',
              ${String(this.options.transactionTimeoutMs)},
              TRUE
            )
          `;
          await transaction.$queryRaw`
            SELECT set_config(
              'lock_timeout',
              ${String(this.options.transactionTimeoutMs)},
              TRUE
            )
          `;

          return transaction.$queryRaw<ClaimRow[]>`
            WITH relay_clock AS MATERIALIZED (
              SELECT clock_timestamp() AS now_at
            ),
            candidates AS (
              SELECT outbox."id"
              FROM "outbox_events" AS outbox
              CROSS JOIN relay_clock
              WHERE outbox."published_at" IS NULL
                AND outbox."available_at" <= relay_clock.now_at
                AND (
                  outbox."lease_expires_at" IS NULL
                  OR outbox."lease_expires_at" <= relay_clock.now_at
                )
              ORDER BY outbox."available_at", outbox."id"
              FOR UPDATE OF outbox SKIP LOCKED
              LIMIT ${input.batchSize}
            )
            UPDATE "outbox_events" AS outbox
            SET
              "locked_by" = ${input.workerId},
              "locked_at" = relay_clock.now_at,
              "lease_expires_at" = relay_clock.now_at
                + (${this.options.leaseDurationMs} * INTERVAL '1 millisecond'),
              "attempt_count" = outbox."attempt_count" + 1,
              "updated_at" = relay_clock.now_at
            FROM candidates
            CROSS JOIN relay_clock
            WHERE outbox."id" = candidates."id"
            RETURNING
              outbox."id",
              outbox."event_id",
              outbox."event_type",
              outbox."merchant_id",
              outbox."aggregate_type",
              outbox."aggregate_id",
              outbox."occurred_at",
              outbox."request_id",
              outbox."payload",
              outbox."attempt_count"
          `;
        },
        {
          maxWait: this.options.transactionTimeoutMs,
          timeout: this.options.transactionTimeoutMs + 1_000,
        },
      );

      const claimed = rows.map((row) => ({
        aggregateId: row.aggregate_id,
        aggregateType: row.aggregate_type,
        attemptCount: row.attempt_count,
        eventId: row.event_id,
        eventType: row.event_type,
        id: row.id,
        merchantId: row.merchant_id,
        occurredAt: row.occurred_at,
        payload: row.payload,
        requestId: row.request_id,
      }));
      this.options.signal?.({
        count: claimed.length,
        durationMs: Math.round(performance.now() - startedAt),
        event: 'outbox.claim.completed',
      });
      return claimed;
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async finalize(input: FinalizeOutboxInput): Promise<FinalizeOutboxResult> {
    if (input.events.length === 0) {
      return { ownershipLost: 0, updated: 0 };
    }

    const startedAt = performance.now();
    try {
      const updated = await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT set_config(
              'statement_timeout',
              ${String(this.options.transactionTimeoutMs)},
              TRUE
            )
          `;
          await transaction.$queryRaw`
            SELECT set_config(
              'lock_timeout',
              ${String(this.options.transactionTimeoutMs)},
              TRUE
            )
          `;
          let updatedCount = 0;

          for (const event of input.events) {
            if (event.kind === 'published') {
              updatedCount += await transaction.$executeRaw`
                UPDATE "outbox_events"
                SET
                  "published_at" = clock_timestamp(),
                  "locked_by" = NULL,
                  "locked_at" = NULL,
                  "lease_expires_at" = NULL,
                  "updated_at" = clock_timestamp()
                WHERE "id" = ${event.id}::uuid
                  AND "event_id" = ${event.eventId}
                  AND "published_at" IS NULL
                  AND "locked_by" = ${input.workerId}
              `;
            } else {
              updatedCount += await transaction.$executeRaw`
                UPDATE "outbox_events"
                SET
                  "available_at" = clock_timestamp()
                    + (${event.retryDelayMs} * INTERVAL '1 millisecond'),
                  "locked_by" = NULL,
                  "locked_at" = NULL,
                  "lease_expires_at" = NULL,
                  "updated_at" = clock_timestamp()
                WHERE "id" = ${event.id}::uuid
                  AND "event_id" = ${event.eventId}
                  AND "published_at" IS NULL
                  AND "locked_by" = ${input.workerId}
              `;
            }
          }

          return updatedCount;
        },
        {
          maxWait: this.options.transactionTimeoutMs,
          timeout: this.options.transactionTimeoutMs + 1_000,
        },
      );

      const result = {
        ownershipLost: input.events.length - updated,
        updated,
      };
      this.options.signal?.({
        count: result.updated,
        durationMs: Math.round(performance.now() - startedAt),
        event: 'outbox.finalize.completed',
      });
      if (result.ownershipLost > 0) {
        this.options.signal?.({
          count: result.ownershipLost,
          event: 'outbox.finalize.ownership_lost',
        });
      }
      return result;
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }
}
