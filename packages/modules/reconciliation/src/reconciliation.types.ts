export type ReconciliationCurrency = 'ETB' | 'USD';
export type ReconciliationEventType = 'adjustment' | 'capture' | 'refund' | 'settlement';
export type ReconciliationBucket =
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'duplicate_provider_row'
  | 'matched_exact'
  | 'platform_only'
  | 'provider_only'
  | 'status_mismatch';

export interface ParsedProviderRow {
  readonly currency: ReconciliationCurrency;
  readonly eventType: ReconciliationEventType;
  readonly externalRef: string | undefined;
  readonly feeMinor: bigint;
  readonly grossMinor: bigint;
  readonly merchantCode: string;
  readonly netMinor: bigint;
  readonly occurredAt: Date;
  readonly providerRef: string;
  readonly providerTransactionId: string;
  readonly rowNumber: number;
  readonly status: 'failed' | 'succeeded';
}

export interface PlatformReconciliationRecord {
  readonly currency: ReconciliationCurrency;
  readonly eventType: string;
  readonly externalRef: string | undefined;
  readonly feeMinor: bigint;
  readonly grossMinor: bigint;
  readonly netMinor: bigint;
  readonly providerRef: string;
  readonly publicRef: string;
  readonly recordType: string;
}

export interface ReconciliationPlatformReadPort {
  readPlatformRecords(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly PlatformReconciliationRecord[]>;
}

export interface StageReconciliationCommand {
  readonly actorApiKeyId: string;
  readonly bytes: Buffer;
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly periodEnd: Date;
  readonly periodStart: Date;
  readonly requestId: string;
}

export interface ReconciliationImportRepresentation {
  readonly createdAt: string;
  readonly id: string;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly rowCount: number;
  readonly status: 'COMPLETED' | 'FAILED' | 'STAGED';
}

export interface ReconciliationSummaryRepresentation {
  readonly amountMismatchCount: number;
  readonly currency: ReconciliationCurrency;
  readonly currencyMismatchCount: number;
  readonly duplicateProviderRowCount: number;
  readonly matchedExactCount: number;
  readonly platformOnlyCount: number;
  readonly providerOnlyCount: number;
  readonly statusMismatchCount: number;
  readonly unexplainedDifferenceMinor: number;
}

export interface ReconciliationReportRepresentation {
  readonly id: string;
  readonly mismatches: readonly {
    readonly bucket: ReconciliationBucket;
    readonly reasonCode: string;
    readonly platformPublicRef?: string;
  }[];
  readonly nextCursor?: string;
  readonly status: 'COMPLETED';
  readonly summaries: readonly ReconciliationSummaryRepresentation[];
}
import type { PrismaTransactionClient } from '@settleflow/infrastructure';
