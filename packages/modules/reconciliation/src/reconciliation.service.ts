import { createHash } from 'node:crypto';

import { EventingService } from '@settleflow/eventing';
import { IdempotencyService } from '@settleflow/idempotency';
import { MonotonicUlidGenerator } from '@settleflow/infrastructure';
import { AuditService } from '@settleflow/operations';

import { parseReconciliationCsv } from './csv-import';
import {
  InvalidReconciliationRequestError,
  ReconciliationCsvInvalidError,
  ReconciliationIdentifierExhaustedError,
  ReconciliationRowLimitExceededError,
} from './reconciliation.errors';
import { PrismaReconciliationRepository } from './prisma-reconciliation.repository';
import type {
  ReconciliationImportRepresentation,
  ReconciliationPlatformReadPort,
  ReconciliationReportRepresentation,
  StageReconciliationCommand,
} from './reconciliation.types';

function canonical(command: StageReconciliationCommand, checksum: string): string {
  return JSON.stringify({
    v: 1,
    checksum,
    periodStart: command.periodStart.toISOString(),
    periodEnd: command.periodEnd.toISOString(),
  });
}

export class ReconciliationService {
  public constructor(
    private readonly repository: PrismaReconciliationRepository,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async stage(
    command: StageReconciliationCommand,
  ): Promise<ReconciliationImportRepresentation> {
    const maximumWindow = 31 * 86_400_000;
    if (
      !Number.isFinite(command.periodStart.getTime()) ||
      !Number.isFinite(command.periodEnd.getTime()) ||
      command.periodStart >= command.periodEnd ||
      command.periodEnd.getTime() - command.periodStart.getTime() > maximumWindow
    )
      throw new InvalidReconciliationRequestError();
    const digest = createHash('sha256').update(command.bytes).digest();
    const acquisition = await this.idempotency.acquire({
      canonicalRequest: canonical(command, digest.toString('hex')),
      key: command.idempotencyKey,
      merchantId: command.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/reconciliation-imports',
      now: this.clock(),
    });
    if (acquisition.kind === 'replay')
      return acquisition.response.body as unknown as ReconciliationImportRepresentation;
    let rows: Awaited<ReturnType<typeof parseReconciliationCsv>> | undefined;
    let failureCode: 'csv_invalid' | 'row_limit_exceeded' | undefined;
    try {
      rows = await parseReconciliationCsv(command.bytes);
      const merchantCode = await this.repository.merchantCode(command.merchantId);
      if (
        rows.some(
          (row) =>
            row.merchantCode !== merchantCode ||
            row.occurredAt < command.periodStart ||
            row.occurredAt >= command.periodEnd,
        )
      ) {
        throw new ReconciliationCsvInvalidError();
      }
    } catch (error: unknown) {
      if (error instanceof ReconciliationRowLimitExceededError) failureCode = 'row_limit_exceeded';
      else if (error instanceof ReconciliationCsvInvalidError) failureCode = 'csv_invalid';
      else throw error;
      rows = undefined;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const importId = `rec_${this.identifiers.generate(this.clock().getTime())}`;
      try {
        return await this.idempotency.complete(acquisition.ownership, async (transaction) => {
          const staged =
            rows === undefined
              ? await this.repository.stageFailed(transaction, {
                  actorApiKeyId: command.actorApiKeyId,
                  byteCount: command.bytes.length,
                  checksum: digest,
                  failureCode: failureCode!,
                  importId,
                  merchantId: command.merchantId,
                  periodEnd: command.periodEnd,
                  periodStart: command.periodStart,
                  requestId: command.requestId,
                })
              : await this.repository.stage(transaction, {
                  actorApiKeyId: command.actorApiKeyId,
                  byteCount: command.bytes.length,
                  checksum: digest,
                  importId,
                  merchantId: command.merchantId,
                  periodEnd: command.periodEnd,
                  periodStart: command.periodStart,
                  requestId: command.requestId,
                  rows,
                });
          const result = staged.representation;
          if (staged.created)
            await this.audit.appendOperational(transaction, {
              action: 'reconciliation.import_created',
              actorApiKeyId: command.actorApiKeyId,
              details: { outcome: result.status.toLowerCase(), rowCount: rows?.length ?? 0 },
              merchantId: command.merchantId,
              occurredAt: new Date(result.createdAt),
              requestId: command.requestId,
              targetId: result.id,
              targetType: 'reconciliation_import',
            });
          const status = result.status === 'STAGED' ? 202 : 201;
          return {
            response: {
              body: result,
              contentType: 'application/json',
              headers: {},
              resultReference: result.id,
              status,
            },
            value: result,
          };
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('unique') && attempt < 3) continue;
        if (message.includes('unique')) throw new ReconciliationIdentifierExhaustedError();
        throw error;
      }
    }
    throw new ReconciliationIdentifierExhaustedError();
  }

  public getReport(
    merchantId: string,
    publicId: string,
    limit = 20,
    cursor?: string,
  ): Promise<ReconciliationReportRepresentation> {
    if (
      !/^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(publicId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined &&
        (cursor.length < 1 || cursor.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(cursor)))
    )
      throw new InvalidReconciliationRequestError();
    return this.repository.getReport(merchantId, publicId, limit, cursor);
  }
}

export class ReconciliationProcessor {
  public constructor(
    private readonly repository: PrismaReconciliationRepository,
    private readonly eventing: EventingService,
    private readonly platformReader: ReconciliationPlatformReadPort,
  ) {}

  public processNext(workerId: string): Promise<boolean> {
    return this.repository.claimAndProcess(
      workerId,
      this.platformReader,
      async (transaction, input) => {
        const event = this.eventing.createReconciliationCompletedEvent(
          {
            importId: input.importId,
            matchedExactCount: input.matchedExactCount,
            merchantId: input.merchantId,
            mismatchCount: input.mismatchCount,
            requestId: input.requestId,
            unexplainedDifferenceMinorByCurrency: input.unexplainedDifferenceMinorByCurrency,
          },
          input.occurredAt,
        );
        await this.eventing.persistDomainEvent(transaction, event);
      },
    );
  }
}
