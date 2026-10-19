import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { EventingService, PrismaOutboxRepository } from '@settleflow/eventing';
import {
  MonotonicUlidGenerator,
  PrismaDatabase,
  type PrismaTransactionClient,
} from '@settleflow/infrastructure';
import {
  PrismaReconciliationRepository,
  ReconciliationClaimOwnershipLostError,
} from '@settleflow/reconciliation';

import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
jest.setTimeout(180_000);

function deploy(databaseUrl: string): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      process.execPath,
      [
        resolve('node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        resolve('prisma.config.mts'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
        timeout: 120_000,
        windowsHide: true,
      },
      (error, _stdout, stderr) =>
        error === null ? resolveCommand() : rejectCommand(new Error(stderr, { cause: error })),
    );
  });
}

interface Deferred {
  readonly blocked: Promise<void>;
  readonly entered: Promise<void>;
  release(): void;
  signal(): void;
}

function deferred(): Deferred {
  let release!: () => void;
  let signal!: () => void;
  const entered = new Promise<void>((resolveEntered) => {
    signal = resolveEntered;
  });
  const blocked = new Promise<void>((resolveBlocked) => {
    release = resolveBlocked;
  });
  return { blocked, entered, release, signal: () => signal() };
}

describe('reconciliation claim ownership with real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer;
  let owner: PrismaDatabase;
  let runtime: PrismaDatabase;
  let repository: PrismaReconciliationRepository;
  let sequence = 0;
  const merchantId = '00000000-0000-4000-8000-000000000301';
  const apiKeyId = '00000000-0000-4000-8000-000000000302';
  const identifiers = new MonotonicUlidGenerator();

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_reconciliation_claim_test')
      .withUsername('settleflow_reconciliation_claim_test')
      .withPassword('settleflow_reconciliation_claim_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
    await deploy(postgres.getConnectionUri());
    owner = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: postgres.getConnectionUri(),
      maxConnections: 8,
    });
    runtime = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: testRuntimeDatabaseUrl(postgres),
      maxConnections: 8,
    });
    repository = new PrismaReconciliationRepository(runtime);
    await owner.getClient().merchant.create({
      data: { code: 'claim_ownership', id: merchantId },
    });
    await owner.getClient().apiKey.create({
      data: {
        id: apiKeyId,
        merchantId,
        prefix: 'sf_test_CLAIMOWNER01',
        scopes: ['reconciliation:write'],
        secretHash: `scrypt:v1:16384:8:1:${'A'.repeat(22)}:${'B'.repeat(43)}`,
      },
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await owner?.close();
    await postgres?.stop();
  });

  afterEach(() => jest.restoreAllMocks());

  async function stage(): Promise<{ readonly id: string; readonly publicId: string }> {
    sequence += 1;
    const id = randomUUID();
    const publicId = `rec_${identifiers.generate(Date.UTC(2026, 7, 3, 10, 0, sequence))}`;
    await owner.getClient().reconciliationImport.create({
      data: {
        byteCount: 1,
        contentSha256: Buffer.alloc(32, sequence),
        id,
        merchantId,
        periodEnd: new Date('2026-08-03T00:00:00Z'),
        periodStart: new Date('2026-08-02T00:00:00Z'),
        publicId,
        rawRowsExpireAt: new Date('2027-01-01T00:00:00Z'),
        requestId: `req_claim_${sequence}`,
        requestedByApiKeyId: apiKeyId,
        rowCount: 1,
      },
    });
    return { id, publicId };
  }

  function process(
    claimOwner: string,
    reader: (transaction: PrismaTransactionClient) => Promise<readonly never[]> = () =>
      Promise.resolve([]),
  ): Promise<boolean> {
    const eventing = new EventingService(
      new PrismaOutboxRepository(),
      new MonotonicUlidGenerator(),
    );
    return repository.claimAndProcess(
      claimOwner,
      {
        readPlatformRecords: (transaction) => reader(transaction),
      },
      async (transaction, input) => {
        const event = eventing.createReconciliationCompletedEvent(
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
        await eventing.persistDomainEvent(transaction, event);
      },
    );
  }

  async function evidence(
    importId: string,
    publicId: string,
  ): Promise<{
    readonly events: number;
    readonly results: number;
    readonly summaries: number;
  }> {
    const [events, results, summaries] = await Promise.all([
      owner.getClient().outboxEvent.count({
        where: { aggregateId: publicId, eventType: 'reconciliation.completed.v1' },
      }),
      owner.getClient().reconciliationResult.count({ where: { importId } }),
      owner.getClient().reconciliationSummary.count({ where: { importId } }),
    ]);
    return { events, results, summaries };
  }

  async function expire(importId: string): Promise<void> {
    await owner.getClient().$executeRaw`
      UPDATE "reconciliation_imports"
      SET "lease_expires_at" = clock_timestamp() - INTERVAL '1 second'
      WHERE "id" = ${importId}::uuid
    `;
  }

  it('uses one PostgreSQL clock for an exact 30-second lease despite JavaScript clock skew', async () => {
    const staged = await stage();
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const gate = deferred();
    const active = process('clock-skew-claim', async () => {
      gate.signal();
      await gate.blocked;
      return [];
    });
    await gate.entered;

    const claim = await owner.getClient().reconciliationImport.findUniqueOrThrow({
      where: { id: staged.id },
    });
    expect(claim.leaseExpiresAt!.getTime() - claim.lockedAt!.getTime()).toBe(30_000);
    gate.release();
    await expect(active).resolves.toBe(true);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 1,
      results: 0,
      summaries: 2,
    });
  });

  it('keeps active competing workers disjoint', async () => {
    const staged = await stage();
    const gate = deferred();
    const active = process('active-owner', async () => {
      gate.signal();
      await gate.blocked;
      return [];
    });
    await gate.entered;

    await expect(process('competing-owner')).resolves.toBe(false);
    gate.release();
    await expect(active).resolves.toBe(true);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 1,
      results: 0,
      summaries: 2,
    });
  });

  it('reclaims an expired lease and rejects stale-worker completion', async () => {
    const staged = await stage();
    const gate = deferred();
    const stale = process('stale-owner', async () => {
      gate.signal();
      await gate.blocked;
      return [];
    });
    await gate.entered;
    await expire(staged.id);

    await expect(process('replacement-owner')).resolves.toBe(true);
    gate.release();
    await expect(stale).rejects.toBeDefined();
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 1,
      results: 0,
      summaries: 2,
    });
  });

  it('rolls back all evidence when the lease expires during classification', async () => {
    const staged = await stage();
    await expect(
      process('expiring-owner', async (transaction) => {
        await transaction.$executeRaw`
          UPDATE "reconciliation_imports"
          SET "lease_expires_at" = clock_timestamp() + INTERVAL '100 milliseconds'
          WHERE "id" = ${staged.id}::uuid
        `;
        await transaction.$queryRaw`SELECT 1 AS result FROM pg_sleep(0.2)`;
        return [];
      }),
    ).rejects.toBeInstanceOf(ReconciliationClaimOwnershipLostError);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 0,
      results: 0,
      summaries: 0,
    });
    expect(
      (await owner.getClient().reconciliationImport.findUniqueOrThrow({ where: { id: staged.id } }))
        .status,
    ).toBe('STAGED');
    await expire(staged.id);
    await expect(process('expired-recovery-owner')).resolves.toBe(true);
  });

  it('recovers interrupted processing only after lease expiry', async () => {
    const staged = await stage();
    await expect(
      process('interrupted-owner', () => Promise.reject(new Error('simulated interruption'))),
    ).rejects.toThrow('simulated interruption');
    await expect(process('early-recovery')).resolves.toBe(false);
    await expire(staged.id);
    await expect(process('recovery-owner')).resolves.toBe(true);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 1,
      results: 0,
      summaries: 2,
    });
  });

  it('fences the terminal overflow failure path after ownership expiry', async () => {
    const staged = await stage();
    const excessive = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(
      repository.claimAndProcess(
        'overflow-owner',
        {
          readPlatformRecords: async (transaction) => {
            await transaction.$executeRaw`
              UPDATE "reconciliation_imports"
              SET "lease_expires_at" = clock_timestamp() + INTERVAL '100 milliseconds'
              WHERE "id" = ${staged.id}::uuid
            `;
            await transaction.$queryRaw`SELECT 1 AS result FROM pg_sleep(0.2)`;
            return [
              {
                currency: 'ETB' as const,
                eventType: 'settlement' as const,
                externalRef: 'overflow',
                feeMinor: 0n,
                grossMinor: excessive,
                netMinor: excessive,
                providerRef: 'overflow',
                publicRef: 'stb_overflow',
                recordType: 'settlement' as const,
              },
            ];
          },
        },
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(ReconciliationClaimOwnershipLostError);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 0,
      results: 0,
      summaries: 0,
    });
    expect(
      await owner.getClient().reconciliationImport.findUniqueOrThrow({ where: { id: staged.id } }),
    ).toMatchObject({ failureCode: null, status: 'STAGED' });
    await expire(staged.id);
    await expect(process('overflow-recovery-owner')).resolves.toBe(true);

    const activeOverflow = await stage();
    await expect(
      repository.claimAndProcess(
        'active-overflow-owner',
        {
          readPlatformRecords: () =>
            Promise.resolve([
              {
                currency: 'ETB' as const,
                eventType: 'settlement' as const,
                externalRef: 'active-overflow',
                feeMinor: 0n,
                grossMinor: excessive,
                netMinor: excessive,
                providerRef: 'active-overflow',
                publicRef: 'stb_active_overflow',
                recordType: 'settlement' as const,
              },
            ]),
        },
        jest.fn(),
      ),
    ).resolves.toBe(true);
    expect(
      await owner
        .getClient()
        .reconciliationImport.findUniqueOrThrow({ where: { id: activeOverflow.id } }),
    ).toMatchObject({ failureCode: 'aggregate_overflow', status: 'FAILED' });
    await expect(evidence(activeOverflow.id, activeOverflow.publicId)).resolves.toEqual({
      events: 0,
      results: 0,
      summaries: 0,
    });
  });

  it('times out a 30-second classification before stale completion and then reclaims it', async () => {
    const staged = await stage();
    await expect(
      process('timeout-owner', async (transaction) => {
        await transaction.$queryRaw`SELECT 1 AS result FROM pg_sleep(31)`;
        return [];
      }),
    ).rejects.toBeDefined();
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 0,
      results: 0,
      summaries: 0,
    });
    await expect(process('post-timeout-owner')).resolves.toBe(true);
    await expect(evidence(staged.id, staged.publicId)).resolves.toEqual({
      events: 1,
      results: 0,
      summaries: 2,
    });
  });
});
