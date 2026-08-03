import { EventingService } from '@settleflow/eventing';
import { IdempotencyService } from '@settleflow/idempotency';
import { MonotonicUlidGenerator } from '@settleflow/infrastructure';
import type { LedgerPostingPort } from '@settleflow/ledger';
import { AuditService } from '@settleflow/operations';
import type { PaymentSettlementReadPort } from '@settleflow/payments';

import {
  InvalidSettlementRequestError,
  SettlementBatchNotFoundError,
  SettlementFeeExceedsGrossError,
  SettlementFeePolicyInvalidError,
  SettlementIdentifierExhaustedError,
  SettlementInvariantViolationError,
} from './settlement.errors';
import { calculateFee, cutoffInstant } from './settlement-policy';
import type {
  RunSettlementCommand,
  SettlementBatchRepresentation,
  SettlementDerivedStatus,
  SettlementRepository,
  SettlementRunRepresentation,
} from './settlement.types';

const MAX_IDENTIFIER_ATTEMPTS = 3;

function canonical(command: RunSettlementCommand): string {
  return JSON.stringify({ v: 1, currency: command.currency, cutoffDate: command.cutoffDate });
}

function isRun(value: unknown): value is SettlementRunRepresentation {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Readonly<Record<string, unknown>>;
  return (
    typeof row['id'] === 'string' &&
    (row['status'] === 'COMPLETED' || row['status'] === 'NO_ELIGIBLE_ITEMS')
  );
}

export class SettlementService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerPostingPort,
    private readonly eventing: EventingService,
    private readonly audit: AuditService,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly payments: PaymentSettlementReadPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(command: RunSettlementCommand): Promise<SettlementRunRepresentation> {
    if (command.currency !== 'ETB' && command.currency !== 'USD')
      throw new InvalidSettlementRequestError();
    const cutoffAt = cutoffInstant(command.cutoffDate, this.clock());
    const acquisition = await this.idempotency.acquire({
      canonicalRequest: canonical(command),
      key: command.idempotencyKey,
      merchantId: command.merchantId,
      method: 'POST',
      normalizedRoute: '/v1/settlement-runs',
      now: this.clock(),
    });
    if (acquisition.kind === 'replay') {
      if (acquisition.response.status !== 201 || !isRun(acquisition.response.body))
        throw new Error('Stored settlement response is invalid');
      return acquisition.response.body;
    }
    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      const seed = this.clock();
      const runId = `str_${this.identifiers.generate(seed.getTime())}`;
      const batchId = `stb_${this.identifiers.generate(seed.getTime())}`;
      try {
        return await this.idempotency.complete(acquisition.ownership, async (transaction) => {
          const occurredAt = await this.repository.transactionTime(transaction);
          const policy = await this.repository.getFeePolicy(transaction, command.currency);
          const expected =
            command.currency === 'ETB'
              ? { basisPoints: 200, flatFeeMinor: 600n }
              : { basisPoints: 200, flatFeeMinor: 25n };
          if (
            policy.basisPoints !== expected.basisPoints ||
            policy.flatFeeMinor !== expected.flatFeeMinor
          ) {
            throw new SettlementFeePolicyInvalidError();
          }
          const candidateClaim = await this.repository.lockCandidates(
            transaction,
            command.merchantId,
            command.currency,
            cutoffAt,
          );
          const paymentFacts = await this.payments.lockSettlementCandidates(
            transaction,
            command.merchantId,
            candidateClaim.candidates.map((candidate) => ({
              paymentIntentId: candidate.paymentIntentId,
              paymentPublicId: candidate.paymentPublicId,
              settlementPositionId: candidate.id,
            })),
          );
          if (paymentFacts.length !== candidateClaim.candidates.length)
            throw new SettlementInvariantViolationError();
          const locked = {
            candidates: paymentFacts
              .filter(
                (fact) =>
                  fact.currency === command.currency &&
                  fact.availableAt !== undefined &&
                  fact.availableAt < cutoffAt &&
                  fact.capturedAmountMinor > fact.refundedAmountMinor,
              )
              .map((fact) => ({
                availableAt: fact.availableAt!,
                capturedAmountMinor: fact.capturedAmountMinor,
                currency: fact.currency,
                id: fact.settlementPositionId,
                paymentIntentId: fact.paymentIntentId,
                paymentPublicId: fact.paymentPublicId,
                refundedAmountMinor: fact.refundedAmountMinor,
              })),
            moreEligible: candidateClaim.moreEligible,
          };
          const adjustmentClaim = await this.repository.lockPendingAdjustments(
            transaction,
            command.merchantId,
            command.currency,
          );
          const adjustments = adjustmentClaim.adjustments;
          const items: ((typeof locked.candidates)[number] &
            ReturnType<typeof calculateFee> & { readonly netMinor: bigint })[] = [];
          let boundedPaymentGross = 0n;
          let boundedFee = 0n;
          for (const candidate of locked.candidates) {
            const grossMinor = candidate.capturedAmountMinor - candidate.refundedAmountMinor;
            const fee = calculateFee(grossMinor, command.currency, policy);
            if (fee.feeMinor >= grossMinor) throw new SettlementFeeExceedsGrossError();
            if (
              boundedPaymentGross + grossMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
              boundedFee + fee.feeMinor > BigInt(Number.MAX_SAFE_INTEGER)
            )
              break;
            boundedPaymentGross += grossMinor;
            boundedFee += fee.feeMinor;
            items.push({ ...candidate, ...fee, netMinor: grossMinor - fee.feeMinor });
          }
          const paymentGrossMinor = items.reduce(
            (total, item) => total + item.capturedAmountMinor - item.refundedAmountMinor,
            0n,
          );
          const feeMinor = items.reduce((total, item) => total + item.feeMinor, 0n);
          const adjustmentMinor = adjustments.reduce(
            (total, adjustment) => total + adjustment.amountMinor,
            0n,
          );
          if (adjustmentMinor > BigInt(Number.MAX_SAFE_INTEGER))
            throw new SettlementInvariantViolationError();
          if (items.length === 0 || paymentGrossMinor - adjustmentMinor <= feeMinor) {
            const run = await this.repository.createNoopRun(transaction, {
              actorApiKeyId: command.actorApiKeyId,
              currency: command.currency,
              cutoffAt,
              cutoffDate: command.cutoffDate,
              merchantId: command.merchantId,
              moreEligible:
                items.length > 0 ||
                adjustments.length > 0 ||
                locked.moreEligible ||
                adjustmentClaim.moreEligible,
              occurredAt,
              requestId: command.requestId,
              runId,
            });
            await this.audit.appendOperational(transaction, {
              action: 'settlement.run_executed',
              actorApiKeyId: command.actorApiKeyId,
              details: { currency: command.currency, outcome: 'no_eligible_items' },
              merchantId: command.merchantId,
              occurredAt,
              requestId: command.requestId,
              targetId: runId,
              targetType: 'settlement_run',
            });
            return {
              response: {
                body: run,
                contentType: 'application/json',
                headers: {},
                resultReference: run.id,
                status: 201,
              },
              value: run,
            };
          }
          const grossMinor = paymentGrossMinor - adjustmentMinor;
          const netMinor = grossMinor - feeMinor;
          const ledger = await this.ledger.postSettlement(transaction, {
            businessReference: batchId,
            currency: command.currency,
            feeMinor,
            grossMinor,
            merchantId: command.merchantId,
            netMinor,
            occurredAt,
            requestId: command.requestId,
          });
          const result = await this.repository.persistSettlement(transaction, {
            actorApiKeyId: command.actorApiKeyId,
            adjustmentMinor,
            adjustments,
            batchId,
            currency: command.currency,
            cutoffAt,
            cutoffDate: command.cutoffDate,
            feeMinor,
            grossMinor,
            items,
            ledgerTransactionInternalId: ledger.internalId,
            ledgerTransactionId: ledger.publicId,
            merchantId: command.merchantId,
            moreEligible:
              locked.moreEligible ||
              adjustmentClaim.moreEligible ||
              items.length < locked.candidates.length,
            netMinor,
            occurredAt,
            paymentGrossMinor,
            requestId: command.requestId,
            runId,
          });
          const event = this.eventing.createSettlementFinalizedEvent(
            {
              batchId,
              currency: command.currency,
              cutoffAt,
              feeAmountMinor: Number(feeMinor),
              grossAmountMinor: Number(grossMinor),
              itemCount: items.length,
              merchantId: command.merchantId,
              netAmountMinor: Number(netMinor),
              requestId: command.requestId,
            },
            occurredAt,
          );
          await this.eventing.persistDomainEvent(transaction, event);
          await this.audit.appendOperational(transaction, {
            action: 'settlement.run_executed',
            actorApiKeyId: command.actorApiKeyId,
            details: { batchId, currency: command.currency, outcome: 'completed' },
            merchantId: command.merchantId,
            occurredAt,
            requestId: command.requestId,
            targetId: runId,
            targetType: 'settlement_run',
          });
          return {
            response: {
              body: result.run,
              contentType: 'application/json',
              headers: {},
              resultReference: result.run.id,
              status: 201,
            },
            value: result.run,
          };
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '';
        if (
          (message.includes('unique') || message.includes('collision')) &&
          attempt < MAX_IDENTIFIER_ATTEMPTS
        )
          continue;
        if (
          (message.includes('unique') || message.includes('collision')) &&
          attempt === MAX_IDENTIFIER_ATTEMPTS
        )
          throw new SettlementIdentifierExhaustedError();
        throw error;
      }
    }
    throw new SettlementIdentifierExhaustedError();
  }

  public async getBatch(
    merchantId: string,
    publicId: string,
    limit = 20,
    cursor?: string,
  ): Promise<SettlementBatchRepresentation> {
    if (
      !/^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(publicId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined &&
        (cursor.length < 1 || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(cursor)))
    )
      throw new InvalidSettlementRequestError();
    const result = await this.repository.findBatch(merchantId, publicId, limit, cursor);
    if (result === undefined) throw new SettlementBatchNotFoundError();
    return result;
  }

  public getPaymentStatus(merchantId: string, paymentId: string): Promise<SettlementDerivedStatus> {
    return this.repository.getDerivedStatus(merchantId, paymentId);
  }
}
