import { PrismaDatabase, type PrismaTransactionClient } from '@settleflow/infrastructure';

import { classifyReconciliation } from './reconciliation-classifier';
import {
  InvalidReconciliationRequestError,
  ReconciliationChecksumConflictError,
  ReconciliationClaimOwnershipLostError,
  ReconciliationImportFailedError,
  ReconciliationImportNotFoundError,
  ReconciliationReportNotReadyError,
} from './reconciliation.errors';
import type {
  ParsedProviderRow,
  ReconciliationPlatformReadPort,
  ReconciliationCurrency,
  ReconciliationImportRepresentation,
  ReconciliationReportRepresentation,
} from './reconciliation.types';

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded))
      throw new Error();
    const row = decoded as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !== 'ordinal,v' ||
      row['v'] !== 1 ||
      !Number.isInteger(row['ordinal']) ||
      Number(row['ordinal']) < 1
    )
      throw new Error();
    if (
      Buffer.from(JSON.stringify({ ordinal: row['ordinal'], v: 1 })).toString('base64url') !==
      cursor
    )
      throw new Error();
    return Number(row['ordinal']);
  } catch {
    throw new InvalidReconciliationRequestError('invalid_cursor');
  }
}

function encodeCursor(ordinal: number): string {
  return Buffer.from(JSON.stringify({ ordinal, v: 1 }), 'utf8').toString('base64url');
}

export interface ReconciliationBacklogRow {
  readonly currency: ReconciliationCurrency;
  readonly reportsWithDifference: number;
}

export class PrismaReconciliationRepository {
  public constructor(private readonly database: PrismaDatabase) {}

  public async readBacklogMetrics(timeoutMs: number): Promise<readonly ReconciliationBacklogRow[]> {
    try {
      return await this.database.getClient().$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`;
          const rows = await transaction.$queryRaw<
            { currency: ReconciliationCurrency; reportsWithDifference: bigint }[]
          >`
            SELECT summary."currency", COUNT(*) AS "reportsWithDifference"
            FROM "reconciliation_summaries" AS summary
            WHERE summary."currency" IN ('ETB', 'USD')
              AND (
                summary."unexplained_difference_minor" <> 0
                OR summary."provider_only_count" > 0
                OR summary."platform_only_count" > 0
                OR summary."currency_mismatch_count" > 0
                OR summary."amount_mismatch_count" > 0
                OR summary."status_mismatch_count" > 0
                OR summary."duplicate_provider_row_count" > 0
              )
            GROUP BY summary."currency"
          `;
          return rows.map((row) => ({
            currency: row.currency,
            reportsWithDifference: Number(row.reportsWithDifference),
          }));
        },
        { maxWait: timeoutMs, timeout: timeoutMs + 1_000 },
      );
    } catch (error: unknown) {
      return this.database.rethrowDatabaseError(error);
    }
  }

  public async merchantCode(merchantId: string): Promise<string> {
    const merchant = await this.database
      .getClient()
      .merchant.findUniqueOrThrow({ select: { code: true }, where: { id: merchantId } });
    return merchant.code;
  }

  public async stage(
    transaction: PrismaTransactionClient,
    input: {
      actorApiKeyId: string;
      byteCount: number;
      checksum: Buffer;
      importId: string;
      merchantId: string;
      periodEnd: Date;
      periodStart: Date;
      requestId: string;
      rows: readonly ParsedProviderRow[];
    },
  ): Promise<{
    readonly created: boolean;
    readonly representation: ReconciliationImportRepresentation;
  }> {
    const checksum = Uint8Array.from(input.checksum);
    const existing = await transaction.reconciliationImport.findUnique({
      where: {
        merchantId_contentSha256: { contentSha256: checksum, merchantId: input.merchantId },
      },
    });
    if (existing !== null) {
      if (
        existing.periodStart.getTime() !== input.periodStart.getTime() ||
        existing.periodEnd.getTime() !== input.periodEnd.getTime() ||
        existing.rowCount !== input.rows.length
      )
        throw new ReconciliationChecksumConflictError();
      return { created: false, representation: this.importRepresentation(existing) };
    }
    const nowRows = await transaction.$queryRaw<
      { now: Date }[]
    >`SELECT transaction_timestamp() AS "now"`;
    const now = nowRows[0]!.now;
    const row = await transaction.reconciliationImport.create({
      data: {
        byteCount: input.byteCount,
        contentSha256: checksum,
        merchantId: input.merchantId,
        periodEnd: input.periodEnd,
        periodStart: input.periodStart,
        publicId: input.importId,
        rawRowsExpireAt: new Date(now.getTime() + 90 * 86_400_000),
        requestId: input.requestId,
        requestedByApiKeyId: input.actorApiKeyId,
        rowCount: input.rows.length,
        status: 'STAGED',
      },
    });
    await transaction.reconciliationProviderRow.createMany({
      data: input.rows.map((provider) => ({
        currency: provider.currency,
        eventType: provider.eventType.toUpperCase() as
          'ADJUSTMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT',
        externalRef: provider.externalRef ?? null,
        feeMinor: provider.feeMinor,
        grossMinor: provider.grossMinor,
        importId: row.id,
        merchantCode: provider.merchantCode,
        netMinor: provider.netMinor,
        occurredAt: provider.occurredAt,
        providerRef: provider.providerRef,
        providerTransactionId: provider.providerTransactionId,
        rowNumber: provider.rowNumber,
        status: provider.status.toUpperCase() as 'FAILED' | 'SUCCEEDED',
      })),
    });
    return { created: true, representation: this.importRepresentation(row) };
  }

  public async stageFailed(
    transaction: PrismaTransactionClient,
    input: {
      actorApiKeyId: string;
      byteCount: number;
      checksum: Buffer;
      failureCode: 'csv_invalid' | 'row_limit_exceeded';
      importId: string;
      merchantId: string;
      periodEnd: Date;
      periodStart: Date;
      requestId: string;
    },
  ): Promise<{
    readonly created: boolean;
    readonly representation: ReconciliationImportRepresentation;
  }> {
    const checksum = Uint8Array.from(input.checksum);
    const existing = await transaction.reconciliationImport.findUnique({
      where: {
        merchantId_contentSha256: { contentSha256: checksum, merchantId: input.merchantId },
      },
    });
    if (existing !== null) {
      if (
        existing.periodStart.getTime() !== input.periodStart.getTime() ||
        existing.periodEnd.getTime() !== input.periodEnd.getTime()
      )
        throw new ReconciliationChecksumConflictError();
      return { created: false, representation: this.importRepresentation(existing) };
    }
    const timeRows = await transaction.$queryRaw<
      { now: Date }[]
    >`SELECT transaction_timestamp() AS "now"`;
    const now = timeRows[0]!.now;
    const row = await transaction.reconciliationImport.create({
      data: {
        byteCount: input.byteCount,
        completedAt: null,
        contentSha256: checksum,
        failedAt: now,
        failureCode: input.failureCode,
        merchantId: input.merchantId,
        periodEnd: input.periodEnd,
        periodStart: input.periodStart,
        publicId: input.importId,
        rawRowsExpireAt: new Date(now.getTime() + 90 * 86_400_000),
        requestId: input.requestId,
        requestedByApiKeyId: input.actorApiKeyId,
        rowCount: 0,
        status: 'FAILED',
      },
    });
    return { created: true, representation: this.importRepresentation(row) };
  }

  public async claimAndProcess(
    claimOwner: string,
    platformReader: ReconciliationPlatformReadPort,
    eventFactory: (
      transaction: PrismaTransactionClient,
      input: {
        importId: string;
        matchedExactCount: number;
        merchantId: string;
        mismatchCount: number;
        occurredAt: Date;
        requestId: string;
        unexplainedDifferenceMinorByCurrency: { ETB: number; USD: number };
      },
    ) => Promise<void>,
  ): Promise<boolean> {
    const claimed = await this.database.getClient().$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        WITH claim_clock AS MATERIALIZED (
          SELECT clock_timestamp() AS now_at
        ), candidate AS (
          SELECT reconciliation_import."id"
          FROM "reconciliation_imports" AS reconciliation_import
          CROSS JOIN claim_clock
          WHERE reconciliation_import."status" = 'staged'
            AND (
              reconciliation_import."lease_expires_at" IS NULL
              OR reconciliation_import."lease_expires_at" <= claim_clock.now_at
            )
          ORDER BY reconciliation_import."created_at", reconciliation_import."id"
          LIMIT 1
          FOR UPDATE OF reconciliation_import SKIP LOCKED
        )
        UPDATE "reconciliation_imports" AS reconciliation_import
        SET "locked_by" = ${claimOwner},
            "locked_at" = claim_clock.now_at,
            "lease_expires_at" = claim_clock.now_at + INTERVAL '30 seconds'
        FROM candidate, claim_clock
        WHERE reconciliation_import."id" = candidate."id"
        RETURNING reconciliation_import."id"
      `;
      return rows[0]?.id;
    });
    if (claimed === undefined) return false;
    await this.database.getClient().$transaction(
      async (tx) => {
        const reconciliationImport = await tx.reconciliationImport.findFirst({
          include: { providerRows: { orderBy: { rowNumber: 'asc' } } },
          where: { id: claimed, lockedBy: claimOwner, status: 'STAGED' },
        });
        if (reconciliationImport === null) throw new ReconciliationClaimOwnershipLostError();
        const platformRows = await platformReader.readPlatformRecords(
          tx,
          reconciliationImport.merchantId,
          reconciliationImport.periodStart,
          reconciliationImport.periodEnd,
        );
        const providerRows: ParsedProviderRow[] = reconciliationImport.providerRows.map((row) => ({
          currency: row.currency as ReconciliationCurrency,
          eventType: row.eventType.toLowerCase() as ParsedProviderRow['eventType'],
          externalRef: row.externalRef ?? undefined,
          feeMinor: row.feeMinor,
          grossMinor: row.grossMinor,
          merchantCode: row.merchantCode,
          netMinor: row.netMinor,
          occurredAt: row.occurredAt,
          providerRef: row.providerRef,
          providerTransactionId: row.providerTransactionId,
          rowNumber: row.rowNumber,
          status: row.status.toLowerCase() as 'failed' | 'succeeded',
        }));
        const results = classifyReconciliation(providerRows, platformRows);
        const transactionTime = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT transaction_timestamp() AS "now"`;
        const completedAt = transactionTime[0]!.now;
        const summaries = (['ETB', 'USD'] as const).map((currency) => {
          const selected = results.filter((result) => result.currency === currency);
          const sum = (
            selector: (result: (typeof selected)[number]) => bigint | undefined,
          ): bigint => selected.reduce((total, result) => total + (selector(result) ?? 0n), 0n);
          const count = (bucket: string): number =>
            selected.filter((result) => result.bucket === bucket).length;
          const providerNet = sum((result) => result.provider?.netMinor);
          const platformNet = sum((result) => result.platform?.netMinor);
          return {
            amountMismatchCount: count('amount_mismatch'),
            completedAt,
            currency,
            currencyMismatchCount: count('currency_mismatch'),
            duplicateProviderRowCount: count('duplicate_provider_row'),
            importId: claimed,
            matchedExactCount: count('matched_exact'),
            platformFeeMinor: sum((result) => result.platform?.feeMinor),
            platformGrossMinor: sum((result) => result.platform?.grossMinor),
            platformNetMinor: platformNet,
            platformOnlyCount: count('platform_only'),
            providerFeeMinor: sum((result) => result.provider?.feeMinor),
            providerGrossMinor: sum((result) => result.provider?.grossMinor),
            providerNetMinor: providerNet,
            providerOnlyCount: count('provider_only'),
            statusMismatchCount: count('status_mismatch'),
            unexplainedDifferenceMinor: providerNet - platformNet,
          };
        });
        const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
        const aggregates = summaries.flatMap((summary) => [
          summary.providerGrossMinor,
          summary.providerFeeMinor,
          summary.providerNetMinor,
          summary.platformGrossMinor,
          summary.platformFeeMinor,
          summary.platformNetMinor,
          summary.unexplainedDifferenceMinor,
        ]);
        if (aggregates.some((amount) => amount < -maximumSafe || amount > maximumSafe)) {
          const failed = await tx.$queryRaw<{ id: string }[]>`
            UPDATE "reconciliation_imports"
            SET "failed_at" = ${completedAt},
                "failure_code" = 'aggregate_overflow',
                "lease_expires_at" = NULL,
                "locked_at" = NULL,
                "locked_by" = NULL,
                "status" = 'failed'
            WHERE "id" = ${claimed}::uuid
              AND "status" = 'staged'
              AND "locked_by" = ${claimOwner}
              AND "lease_expires_at" > clock_timestamp()
            RETURNING "id"
          `;
          if (failed.length !== 1) throw new ReconciliationClaimOwnershipLostError();
          return;
        }
        const completed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "reconciliation_imports"
          SET "completed_at" = ${completedAt},
              "lease_expires_at" = NULL,
              "locked_at" = NULL,
              "locked_by" = NULL,
              "status" = 'completed'
          WHERE "id" = ${claimed}::uuid
            AND "status" = 'staged'
            AND "locked_by" = ${claimOwner}
            AND "lease_expires_at" > clock_timestamp()
          RETURNING "id"
        `;
        if (completed.length !== 1) throw new ReconciliationClaimOwnershipLostError();
        await tx.reconciliationResult.createMany({
          data: results.map((result, index) => ({
            bucket: result.bucket.toUpperCase() as never,
            currency: result.currency,
            importId: claimed,
            matchedBy: result.matchedBy ?? null,
            platformFeeMinor: result.platform?.feeMinor ?? null,
            platformGrossMinor: result.platform?.grossMinor ?? null,
            platformNetMinor: result.platform?.netMinor ?? null,
            platformPublicRef: result.platform?.publicRef ?? null,
            platformRecordType: result.platform?.recordType ?? null,
            providerFeeMinor: result.provider?.feeMinor ?? null,
            providerGrossMinor: result.provider?.grossMinor ?? null,
            providerNetMinor: result.provider?.netMinor ?? null,
            providerRowId:
              result.provider === undefined
                ? null
                : reconciliationImport.providerRows[result.provider.rowNumber - 1]!.id,
            reasonCode: result.reasonCode,
            sortOrdinal: index + 1,
          })),
        });
        await tx.reconciliationSummary.createMany({ data: summaries });
        const matchedExactCount = results.filter(
          (result) => result.bucket === 'matched_exact',
        ).length;
        const mismatchCount = results.length - matchedExactCount;
        await eventFactory(tx, {
          importId: reconciliationImport.publicId,
          matchedExactCount,
          merchantId: reconciliationImport.merchantId,
          mismatchCount,
          occurredAt: completedAt,
          requestId: reconciliationImport.requestId,
          unexplainedDifferenceMinorByCurrency: {
            ETB: Number(summaries[0]!.unexplainedDifferenceMinor),
            USD: Number(summaries[1]!.unexplainedDifferenceMinor),
          },
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
    return true;
  }

  public async getReport(
    merchantId: string,
    publicId: string,
    limit: number,
    cursor?: string,
  ): Promise<ReconciliationReportRepresentation> {
    const afterOrdinal = decodeCursor(cursor);
    const row = await this.database.getClient().reconciliationImport.findFirst({
      include: {
        results: {
          orderBy: { sortOrdinal: 'asc' },
          take: limit + 1,
          where: { bucket: { not: 'MATCHED_EXACT' }, sortOrdinal: { gt: afterOrdinal } },
        },
        summaries: { orderBy: { currency: 'asc' } },
      },
      where: { merchantId, publicId },
    });
    if (row === null) throw new ReconciliationImportNotFoundError();
    if (row.status === 'STAGED') throw new ReconciliationReportNotReadyError();
    if (row.status === 'FAILED') throw new ReconciliationImportFailedError();
    const visible = row.results.slice(0, limit);
    const nextCursor =
      row.results.length > limit ? encodeCursor(visible.at(-1)!.sortOrdinal) : undefined;
    return {
      id: row.publicId,
      mismatches: visible.map((result) => ({
        bucket: result.bucket.toLowerCase() as never,
        ...(result.platformPublicRef === null
          ? {}
          : { platformPublicRef: result.platformPublicRef }),
        reasonCode: result.reasonCode,
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      status: 'COMPLETED',
      summaries: row.summaries.map((summary) => ({
        amountMismatchCount: summary.amountMismatchCount,
        currency: summary.currency as ReconciliationCurrency,
        currencyMismatchCount: summary.currencyMismatchCount,
        duplicateProviderRowCount: summary.duplicateProviderRowCount,
        matchedExactCount: summary.matchedExactCount,
        platformOnlyCount: summary.platformOnlyCount,
        providerOnlyCount: summary.providerOnlyCount,
        statusMismatchCount: summary.statusMismatchCount,
        unexplainedDifferenceMinor: Number(summary.unexplainedDifferenceMinor),
      })),
    };
  }

  private importRepresentation(row: {
    createdAt: Date;
    periodEnd: Date;
    periodStart: Date;
    publicId: string;
    rowCount: number;
    status: string;
  }): ReconciliationImportRepresentation {
    return {
      createdAt: row.createdAt.toISOString(),
      id: row.publicId,
      periodEnd: row.periodEnd.toISOString(),
      periodStart: row.periodStart.toISOString(),
      rowCount: row.rowCount,
      status: row.status as ReconciliationImportRepresentation['status'],
    };
  }
}
