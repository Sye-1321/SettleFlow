import { Injectable } from '@nestjs/common';
import type { PrismaTransactionClient } from '@settleflow/infrastructure';
import type { LedgerReconciliationReadPort } from '@settleflow/ledger';
import type { PaymentReconciliationReadPort } from '@settleflow/payments';
import type {
  PlatformReconciliationRecord,
  ReconciliationPlatformReadPort,
} from '@settleflow/reconciliation';
import type { SettlementReconciliationReadPort } from '@settleflow/settlements';

@Injectable()
export class ReconciliationPlatformReadAdapter implements ReconciliationPlatformReadPort {
  public constructor(
    private readonly payments: PaymentReconciliationReadPort,
    private readonly settlements: SettlementReconciliationReadPort,
    private readonly ledger: LedgerReconciliationReadPort,
  ) {}

  public async readPlatformRecords(
    transaction: PrismaTransactionClient,
    merchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<readonly PlatformReconciliationRecord[]> {
    const [payments, settlements] = await Promise.all([
      this.payments.readPaymentEvidence(transaction, merchantId, periodStart, periodEnd),
      this.settlements.readSettlementEvidence(transaction, merchantId, periodStart, periodEnd),
    ]);
    const evidence = [...payments, ...settlements];
    const references = await this.ledger.resolveReconciliationReferences(
      transaction,
      merchantId,
      evidence.map((row) => ({
        businessReference: row.businessReference,
        businessType: row.eventType === 'adjustment' ? 'settlement' : row.eventType,
      })),
    );
    const providerReferences = new Map(
      references.map((row) => [`${row.businessType}:${row.businessReference}`, row.providerRef]),
    );
    return evidence
      .map((row) => {
        const businessType = row.eventType === 'adjustment' ? 'settlement' : row.eventType;
        const providerRef = providerReferences.get(`${businessType}:${row.businessReference}`);
        if (providerRef === undefined) throw new Error('reconciliation_ledger_reference_missing');
        return {
          currency: row.currency,
          eventType: row.eventType,
          externalRef: row.externalRef,
          feeMinor: 'feeMinor' in row ? row.feeMinor : 0n,
          grossMinor: row.grossMinor,
          netMinor: 'netMinor' in row ? row.netMinor : row.grossMinor,
          occurredAt: row.occurredAt,
          providerRef,
          publicRef: row.publicRef,
          recordType: row.eventType,
        };
      })
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() ||
          left.eventType.localeCompare(right.eventType) ||
          left.publicRef.localeCompare(right.publicRef),
      )
      .map((row) => ({
        currency: row.currency,
        eventType: row.eventType,
        externalRef: row.externalRef,
        feeMinor: row.feeMinor,
        grossMinor: row.grossMinor,
        netMinor: row.netMinor,
        providerRef: row.providerRef,
        publicRef: row.publicRef,
        recordType: row.recordType,
      }));
  }
}
