import { PrismaDatabase } from '@settleflow/infrastructure';

import {
  IdempotencyKeyExpiredError,
  IdempotencyKeyReusedError,
  IdempotencyOwnershipLostError,
  IdempotencyRequestInProgressError,
} from './idempotency.errors';
import { PrismaIdempotencyRepository } from './prisma-idempotency.repository';
import type { HashedIdempotencyAcquireCommand } from './idempotency.types';

interface IdempotencyRepositoryHarness {
  readonly client: { readonly $transaction: jest.Mock };
  readonly database: PrismaDatabase;
  readonly repository: PrismaIdempotencyRepository;
  readonly transaction: {
    readonly $executeRaw: jest.Mock;
    readonly $queryRaw: jest.Mock;
  };
}

describe('PrismaIdempotencyRepository', () => {
  const now = new Date('2026-08-03T10:00:00.000Z');
  const options = {
    leaseDurationMs: 30_000,
    lockTimeoutMs: 250,
    replayDurationMs: 60_000,
    statementTimeoutMs: 2_000,
  };
  const command: HashedIdempotencyAcquireCommand = {
    keyHash: Uint8Array.from([1]),
    merchantId: 'merchant',
    method: 'POST',
    normalizedRoute: '/v1/payment-intents',
    now,
    ownerToken: 'owner',
    recordId: 'record',
    requestHash: Uint8Array.from([2]),
  };

  function harness(rows: readonly unknown[] = []): IdempotencyRepositoryHarness {
    const transaction = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(rows),
    };
    const client = {
      $transaction: jest
        .fn()
        .mockImplementation(
          (operation: (value: typeof transaction) => Promise<unknown>): Promise<unknown> =>
            operation(transaction),
        ),
    };
    const database = {
      getClient: jest.fn().mockReturnValue(client),
      rethrowDatabaseError: jest.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
    } as unknown as PrismaDatabase;
    return {
      client,
      database,
      repository: new PrismaIdempotencyRepository(database, options, () => now),
      transaction,
    };
  }

  function row(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'record',
      lease_expires_at: new Date(now.getTime() + 1_000),
      owner_token: 'owner',
      request_hash: command.requestHash,
      response_body: { ok: true },
      response_content_type: 'application/json',
      response_expires_at: new Date(now.getTime() + 1_000),
      response_headers: { 'x-test': 'yes' },
      response_status: 201,
      result_reference: 'result',
      state: 'in_progress',
      ...overrides,
    };
  }

  it('acquires an inserted owner and rejects missing or changed rows', async () => {
    await expect(harness([row()]).repository.acquire(command)).resolves.toEqual({
      kind: 'acquired',
      ownership: { ownerToken: 'owner', recordId: 'record' },
    });
    await expect(harness([]).repository.acquire(command)).rejects.toThrow(
      'Idempotency acquisition returned no row',
    );
    await expect(
      harness([row({ request_hash: Uint8Array.from([9]) })]).repository.acquire(command),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('replays only complete, unexpired, structurally valid responses', async () => {
    await expect(
      harness([row({ state: 'completed' })]).repository.acquire(command),
    ).resolves.toMatchObject({
      kind: 'replay',
      response: { resultReference: 'result', status: 201 },
    });
    const invalidRows = [
      row({ state: 'completed', response_status: null }),
      row({ state: 'completed', response_content_type: 'text/plain' }),
      row({ state: 'completed', response_headers: { bad: 1 } }),
      row({ state: 'completed', response_body: [] }),
      row({ state: 'completed', response_expires_at: now }),
    ];
    for (const invalid of invalidRows)
      await expect(harness([invalid]).repository.acquire(command)).rejects.toBeInstanceOf(
        IdempotencyKeyExpiredError,
      );
    await expect(
      harness([row({ state: 'completed', result_reference: null })]).repository.acquire(command),
    ).resolves.toMatchObject({ response: { status: 201 } });
  });

  it('protects active owners and performs only a successful expired takeover', async () => {
    await expect(
      harness([row({ owner_token: 'other' })]).repository.acquire(command),
    ).rejects.toBeInstanceOf(IdempotencyRequestInProgressError);
    const takeover = harness([
      row({ lease_expires_at: new Date(now.getTime() - 1), owner_token: 'other' }),
    ]);
    takeover.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        row({ lease_expires_at: new Date(now.getTime() - 1), owner_token: 'other' }),
      ])
      .mockResolvedValueOnce([{ id: 'record' }]);
    await expect(takeover.repository.acquire(command)).resolves.toMatchObject({ kind: 'acquired' });
    const loser = harness([row({ lease_expires_at: null, owner_token: 'other' })]);
    loser.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([row({ lease_expires_at: null, owner_token: 'other' })])
      .mockResolvedValueOnce([]);
    await expect(loser.repository.acquire(command)).rejects.toBeInstanceOf(
      IdempotencyRequestInProgressError,
    );
  });

  it('completes the business operation and response snapshot under ownership', async () => {
    const h = harness();
    h.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ id: 'record' }]);
    h.transaction.$executeRaw.mockResolvedValue(1);
    await expect(
      h.repository.complete({ ownerToken: 'owner', recordId: 'record' }, () =>
        Promise.resolve({
          response: {
            body: { ok: true },
            contentType: 'application/json',
            headers: {},
            status: 201,
          },
          value: 'done',
        }),
      ),
    ).resolves.toBe('done');
    expect(h.transaction.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('fails closed when ownership is absent or lost during finalization', async () => {
    const missing = harness();
    missing.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);
    await expect(
      missing.repository.complete({ ownerToken: 'owner', recordId: 'record' }, () =>
        Promise.resolve({
          response: { body: {}, contentType: 'application/json', headers: {}, status: 200 },
          value: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyOwnershipLostError);
    const lost = harness();
    lost.transaction.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ id: 'record' }]);
    lost.transaction.$executeRaw.mockResolvedValue(0);
    await expect(
      lost.repository.complete({ ownerToken: 'owner', recordId: 'record' }, () =>
        Promise.resolve({
          response: {
            body: {},
            contentType: 'application/problem+json',
            headers: {},
            resultReference: 'result',
            status: 409,
          },
          value: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyOwnershipLostError);
  });
});
