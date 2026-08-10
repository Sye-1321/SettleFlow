import { EventingService } from '@settleflow/eventing';
import { IdempotencyService, type IdempotentOperation } from '@settleflow/idempotency';
import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';
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
import { SettlementService } from './settlement.service';
import type {
  PersistSettlementInput,
  RunSettlementCommand,
  SettlementBatchRepresentation,
  SettlementPositionCandidate,
  SettlementRepository,
  SettlementRunRepresentation,
} from './settlement.types';

interface SettlementServiceHarness {
  readonly audit: jest.Mocked<AuditService>;
  readonly batch: SettlementBatchRepresentation;
  readonly eventing: jest.Mocked<EventingService>;
  readonly idempotency: jest.Mocked<IdempotencyService>;
  readonly identifiers: jest.Mocked<MonotonicUlidGenerator>;
  readonly ledger: jest.Mocked<LedgerPostingPort>;
  readonly mocks: {
    readonly appendOperational: jest.Mock;
    readonly createNoopRun: jest.Mock;
    readonly findBatch: jest.Mock;
    readonly generate: jest.Mock;
    readonly persistDomainEvent: jest.Mock;
    readonly postSettlement: jest.Mock;
  };
  readonly payments: jest.Mocked<PaymentSettlementReadPort>;
  readonly repository: jest.Mocked<SettlementRepository>;
  readonly run: SettlementRunRepresentation;
  readonly service: SettlementService;
}

describe('SettlementService financial orchestration', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const transaction = {} as PrismaTransactionClient;
  const command: RunSettlementCommand = {
    actorApiKeyId: 'key-id',
    currency: 'ETB',
    cutoffDate: '2026-08-02',
    idempotencyKey: 'settlement-key',
    merchantId: 'merchant-id',
    requestId: 'req-settlement',
  };
  const candidate: SettlementPositionCandidate = {
    availableAt: new Date('2026-08-01T00:00:00.000Z'),
    capturedAmountMinor: 100_000n,
    currency: 'ETB',
    id: 'position-id',
    paymentIntentId: 'payment-internal-id',
    paymentPublicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    refundedAmountMinor: 0n,
  };

  function harness(): SettlementServiceHarness {
    const run: SettlementRunRepresentation = {
      completedAt: now.toISOString(),
      currency: 'ETB' as const,
      cutoffAt: '2026-08-02T21:00:00.000Z',
      cutoffDate: command.cutoffDate,
      id: 'str_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      moreEligible: false,
      status: 'NO_ELIGIBLE_ITEMS' as const,
    };
    const batch: SettlementBatchRepresentation = {
      adjustmentAmountMinor: 0,
      adjustmentCount: 0,
      adjustments: [],
      createdAt: now.toISOString(),
      currency: 'ETB' as const,
      cutoffAt: run.cutoffAt,
      feeAmountMinor: 2_600,
      grossAmountMinor: 100_000,
      id: 'stb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      itemCount: 1,
      items: [],
      ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      netAmountMinor: 97_400,
      paymentGrossAmountMinor: 100_000,
      settledAt: now.toISOString(),
      status: 'SETTLED' as const,
    };
    const createNoopRun = jest.fn().mockResolvedValue(run);
    const persistSettlement = jest
      .fn()
      .mockImplementation(
        (
          _tx: PrismaTransactionClient,
          input: PersistSettlementInput,
        ): ReturnType<SettlementRepository['persistSettlement']> =>
          Promise.resolve({
            batch,
            run: { ...run, batchId: input.batchId, id: input.runId, status: 'COMPLETED' },
          }),
      );
    const findBatch = jest.fn().mockResolvedValue(batch);
    const repository = {
      createNoopRun,
      findBatch,
      getDerivedStatus: jest.fn().mockResolvedValue('ELIGIBLE'),
      getFeePolicy: jest.fn().mockResolvedValue({
        basisPoints: 200,
        currency: 'ETB',
        flatFeeMinor: 600n,
        version: 'settlement_fee_v1',
      }),
      lockCandidates: jest.fn().mockResolvedValue({ candidates: [candidate], moreEligible: false }),
      lockPendingAdjustments: jest.fn().mockResolvedValue({ adjustments: [], moreEligible: false }),
      persistSettlement,
      projectLifecycle: jest.fn(),
      transactionTime: jest.fn().mockResolvedValue(now),
    } as unknown as jest.Mocked<SettlementRepository>;
    const idempotency = {
      acquire: jest.fn().mockResolvedValue({
        kind: 'acquired',
        ownership: { ownerToken: 'owner', recordId: 'record' },
      }),
      complete: jest
        .fn()
        .mockImplementation(
          async (_owner, operation: IdempotentOperation<unknown>) =>
            (await operation(transaction)).value,
        ),
    } as unknown as jest.Mocked<IdempotencyService>;
    const postSettlement = jest
      .fn()
      .mockResolvedValue({ internalId: 'ledger-internal', publicId: batch.ledgerTransactionId });
    const ledger = {
      postCapture: jest.fn(),
      postRefund: jest.fn(),
      postSettlement,
      reverse: jest.fn(),
    } as unknown as jest.Mocked<LedgerPostingPort>;
    const persistDomainEvent = jest.fn().mockResolvedValue(undefined);
    const eventing = {
      createSettlementFinalizedEvent: jest.fn().mockReturnValue({ eventId: 'event-id' }),
      persistDomainEvent,
    } as unknown as jest.Mocked<EventingService>;
    const appendOperational = jest.fn().mockResolvedValue(undefined);
    const audit = { appendOperational } as unknown as jest.Mocked<AuditService>;
    const generate = jest.fn().mockReturnValue('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const identifiers = { generate } as unknown as jest.Mocked<MonotonicUlidGenerator>;
    const payments = {
      lockSettlementCandidates: jest.fn().mockResolvedValue([candidate]),
      readSettlementProjectionIdentity: jest.fn(),
    } as unknown as jest.Mocked<PaymentSettlementReadPort>;
    const service = new SettlementService(
      repository,
      idempotency,
      ledger,
      eventing,
      audit,
      identifiers,
      payments,
      () => now,
    );
    return {
      audit,
      batch,
      eventing,
      idempotency,
      identifiers,
      ledger,
      mocks: {
        appendOperational,
        createNoopRun,
        findBatch,
        generate,
        persistDomainEvent,
        postSettlement,
      },
      payments,
      repository,
      run,
      service,
    };
  }

  it('atomically posts an eligible batch, event, and audit', async () => {
    const h = harness();
    await expect(h.service.run(command)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(h.mocks.postSettlement).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ feeMinor: 2_600n, grossMinor: 100_000n, netMinor: 97_400n }),
    );
    expect(h.mocks.persistDomainEvent).toHaveBeenCalledWith(transaction, expect.anything());
    expect(h.mocks.appendOperational).toHaveBeenCalled();
  });

  it('creates an audited no-op when no candidate is eligible', async () => {
    const h = harness();
    h.repository.lockCandidates.mockResolvedValue({ candidates: [], moreEligible: false });
    h.payments.lockSettlementCandidates.mockResolvedValue([]);
    await expect(h.service.run(command)).resolves.toMatchObject({ status: 'NO_ELIGIBLE_ITEMS' });
    expect(h.mocks.createNoopRun).toHaveBeenCalled();
    expect(h.mocks.postSettlement).not.toHaveBeenCalled();
  });

  it('replays only a valid completed settlement snapshot', async () => {
    const h = harness();
    h.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: h.run,
        contentType: 'application/json',
        headers: {},
        resultReference: h.run.id,
        status: 201,
      },
    });
    await expect(h.service.run(command)).resolves.toEqual(h.run);
    h.idempotency.acquire.mockResolvedValue({
      kind: 'replay',
      response: {
        body: {},
        contentType: 'application/json',
        headers: {},
        resultReference: 'bad',
        status: 200,
      },
    });
    await expect(h.service.run(command)).rejects.toThrow('Stored settlement response is invalid');
  });

  it('fails closed on currency, policy, identity, fee, and aggregate violations', async () => {
    const invalid = harness();
    await expect(
      invalid.service.run({ ...command, currency: 'GBP' as 'ETB' }),
    ).rejects.toBeInstanceOf(InvalidSettlementRequestError);
    const policy = harness();
    policy.repository.getFeePolicy.mockResolvedValue({
      basisPoints: 201,
      currency: 'ETB',
      flatFeeMinor: 600n,
      version: 'settlement_fee_v1',
    });
    await expect(policy.service.run(command)).rejects.toBeInstanceOf(
      SettlementFeePolicyInvalidError,
    );
    const identity = harness();
    identity.payments.lockSettlementCandidates.mockResolvedValue([]);
    await expect(identity.service.run(command)).rejects.toBeInstanceOf(
      SettlementInvariantViolationError,
    );
    const fee = harness();
    fee.repository.lockCandidates.mockResolvedValue({
      candidates: [{ ...candidate, capturedAmountMinor: 600n }],
      moreEligible: false,
    });
    fee.payments.lockSettlementCandidates.mockResolvedValue([
      { ...candidate, capturedAmountMinor: 600n, settlementPositionId: candidate.id },
    ]);
    await expect(fee.service.run(command)).rejects.toBeInstanceOf(SettlementFeeExceedsGrossError);
    const aggregate = harness();
    aggregate.repository.lockPendingAdjustments.mockResolvedValue({
      adjustments: [{ amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n, id: 'adjustment' }],
      moreEligible: false,
    });
    await expect(aggregate.service.run(command)).rejects.toBeInstanceOf(
      SettlementInvariantViolationError,
    );
  });

  it('bounds identifier collision retries and preserves other failures', async () => {
    const collision = harness();
    collision.repository.persistSettlement.mockRejectedValue(new Error('unique collision'));
    await expect(collision.service.run(command)).rejects.toBeInstanceOf(
      SettlementIdentifierExhaustedError,
    );
    expect(collision.mocks.generate).toHaveBeenCalledTimes(6);
    const failure = harness();
    failure.repository.persistSettlement.mockRejectedValue(new Error('database unavailable'));
    await expect(failure.service.run(command)).rejects.toThrow('database unavailable');
  });

  it('validates and tenant-scopes batch and derived-status reads', async () => {
    const h = harness();
    await expect(h.service.getBatch('merchant-id', h.batch.id, 20, 'cursor_1')).resolves.toEqual(
      h.batch,
    );
    expect(h.mocks.findBatch).toHaveBeenCalledWith('merchant-id', h.batch.id, 20, 'cursor_1');
    await expect(h.service.getBatch('merchant-id', 'bad')).rejects.toBeInstanceOf(
      InvalidSettlementRequestError,
    );
    await expect(h.service.getBatch('merchant-id', h.batch.id, 101)).rejects.toBeInstanceOf(
      InvalidSettlementRequestError,
    );
    await expect(
      h.service.getBatch('merchant-id', h.batch.id, 20, 'bad cursor'),
    ).rejects.toBeInstanceOf(InvalidSettlementRequestError);
    h.repository.findBatch.mockResolvedValue(undefined);
    await expect(h.service.getBatch('merchant-id', h.batch.id)).rejects.toBeInstanceOf(
      SettlementBatchNotFoundError,
    );
    await expect(
      h.service.getPaymentStatus('merchant-id', candidate.paymentPublicId),
    ).resolves.toBe('ELIGIBLE');
  });
});
