import type { PrismaTransactionClient } from '@settleflow/infrastructure';

import type { LedgerReconciliationReadPort, LedgerReconciliationReference } from './ledger.types';

const CHUNK_SIZE = 500;

export class PrismaLedgerReconciliationReader implements LedgerReconciliationReadPort {
  public async resolveReconciliationReferences(
    transaction: PrismaTransactionClient,
    merchantId: string,
    references: readonly {
      readonly businessReference: string;
      readonly businessType: 'capture' | 'refund' | 'settlement';
    }[],
  ): Promise<readonly LedgerReconciliationReference[]> {
    const unique = [
      ...new Map(
        references.map((reference) => [
          `${reference.businessType}:${reference.businessReference}`,
          reference,
        ]),
      ).values(),
    ];
    const result: LedgerReconciliationReference[] = [];
    for (let offset = 0; offset < unique.length; offset += CHUNK_SIZE) {
      const chunk = unique.slice(offset, offset + CHUNK_SIZE);
      const rows = await transaction.ledgerTransaction.findMany({
        select: { businessReference: true, businessType: true, publicId: true },
        where: {
          merchantId,
          OR: chunk.map((reference) => ({
            businessReference: reference.businessReference,
            businessType: reference.businessType.toUpperCase() as
              'CAPTURE' | 'REFUND' | 'SETTLEMENT',
          })),
        },
      });
      result.push(
        ...rows.map((row) => ({
          businessReference: row.businessReference,
          businessType: row.businessType.toLowerCase() as 'capture' | 'refund' | 'settlement',
          providerRef: row.publicId,
        })),
      );
    }
    return result;
  }
}
