import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MonotonicUlidGenerator, PrismaDatabase } from '@settleflow/infrastructure';
import {
  LedgerAccountsNotProvisionedError,
  LedgerBusinessReferenceConflictError,
  LedgerIdentifierCollisionError,
  LedgerReversalConflictError,
  LedgerService,
  LedgerTransactionNotFoundError,
  PrismaLedgerRepository,
} from '@settleflow/ledger';

import { provisionTestRuntimeRole, testRuntimeDatabaseUrl } from './support/postgres-runtime-role';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const PRE_LEDGER_MIGRATIONS = [
  '20260731000000_prisma_data_foundation',
  '20260731222515_merchant_access',
  '20260801095331_payment_intent_m1_database_foundation',
  '20260801180000_webhook_endpoint_foundation',
  '20260802092702_payment_created_webhook_projection_consumer',
  '20260802150000_signed_webhook_delivery_and_retries',
] as const;
const LEDGER_MIGRATION = '20260802180000_immutable_double_entry_ledger_foundation';

jest.setTimeout(120_000);

function deployMigrations(databaseUrl: string): Promise<void> {
  const prismaCli = resolve(process.cwd(), 'node_modules/prisma/build/index.js');
  const config = resolve(process.cwd(), 'prisma.config.mts');
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', config],
      {
        cwd: process.cwd(),
        env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
        timeout: 120_000,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error !== null) {
          rejectCommand(new Error(`Prisma migrate deploy failed: ${stderr}`, { cause: error }));
          return;
        }
        resolveCommand();
      },
    );
  });
}

async function executeSql(
  postgres: StartedPostgreSqlContainer,
  database: string,
  sql: string,
): Promise<string> {
  const result = await postgres.exec([
    'psql',
    '--username',
    postgres.getUsername(),
    '--dbname',
    database,
    '--set',
    'ON_ERROR_STOP=1',
    '--tuples-only',
    '--no-align',
    '--command',
    sql,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`PostgreSQL command failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function migrationSql(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'prisma', 'migrations', name, 'migration.sql'),
    'utf8',
  );
}

describe('immutable double-entry Ledger Foundation with real PostgreSQL', () => {
  let ownerDatabase: PrismaDatabase | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let runtimeDatabase: PrismaDatabase | undefined;
  let ledger: LedgerService | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('settleflow_ledger_test')
      .withUsername('settleflow_ledger_test')
      .withPassword('settleflow_ledger_test_only')
      .start();
    await provisionTestRuntimeRole(postgres);
    await deployMigrations(postgres.getConnectionUri());
    ownerDatabase = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: postgres.getConnectionUri(),
      maxConnections: 8,
    });
    runtimeDatabase = new PrismaDatabase({
      connectionTimeoutMs: 15_000,
      databaseUrl: testRuntimeDatabaseUrl(postgres),
      maxConnections: 8,
    });
    ledger = new LedgerService(
      new PrismaLedgerRepository(runtimeDatabase),
      new MonotonicUlidGenerator(),
    );
  }, 120_000);

  afterAll(async () => {
    await runtimeDatabase?.close();
    await ownerDatabase?.close();
    await postgres?.stop();
  }, 120_000);

  function dependencies(): {
    readonly ledger: LedgerService;
    readonly owner: PrismaDatabase;
    readonly postgres: StartedPostgreSqlContainer;
    readonly runtime: PrismaDatabase;
  } {
    if (
      ledger === undefined ||
      ownerDatabase === undefined ||
      postgres === undefined ||
      runtimeDatabase === undefined
    ) {
      throw new Error('Ledger integration dependencies are unavailable');
    }
    return { ledger, owner: ownerDatabase, postgres, runtime: runtimeDatabase };
  }

  async function createMerchant(code: string, provision = true): Promise<string> {
    const { ledger: service, owner, runtime } = dependencies();
    const merchant = await owner.getClient().merchant.create({ data: { code } });
    if (provision) {
      await runtime.getClient().$transaction(async (transaction) => {
        await service.provisionAccounts(transaction, merchant.id);
      });
    }
    return merchant.id;
  }

  it('upgrades a populated prior schema and provisions exactly the closed chart', async () => {
    const { postgres: container } = dependencies();
    const upgradeDatabase = 'settleflow_ledger_upgrade_test';
    await executeSql(container, container.getDatabase(), `CREATE DATABASE "${upgradeDatabase}";`);
    for (const migration of PRE_LEDGER_MIGRATIONS) {
      await executeSql(container, upgradeDatabase, migrationSql(migration));
    }
    await executeSql(
      container,
      upgradeDatabase,
      `INSERT INTO merchants (id, code) VALUES
        ('00000000-0000-4000-8000-000000000101', 'mrc_ledger_upgrade_one'),
        ('00000000-0000-4000-8000-000000000102', 'mrc_ledger_upgrade_two');
       INSERT INTO payment_intents
         (id, public_id, merchant_id, external_ref, amount_minor, currency, capture_method)
       VALUES
         ('00000000-0000-4000-8000-000000000103', 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAE',
          '00000000-0000-4000-8000-000000000101', 'upgrade-evidence', 100, 'ETB', 'manual');`,
    );
    await executeSql(container, upgradeDatabase, migrationSql(LEDGER_MIGRATION));

    const accounts = await executeSql(
      container,
      upgradeDatabase,
      `SELECT merchant_id || '|' || currency || '|' || code::text || '|' || normal_side::text
       FROM ledger_accounts ORDER BY merchant_id, currency, code;`,
    );
    expect(accounts.split(/\r?\n/u)).toHaveLength(8);
    expect(accounts).toContain('00000000-0000-4000-8000-000000000101|ETB|provider_clearing|debit');
    expect(accounts).toContain('00000000-0000-4000-8000-000000000102|USD|merchant_payable|credit');
    expect(
      await executeSql(container, upgradeDatabase, 'SELECT count(*) FROM payment_intents;'),
    ).toBe('1');
  });

  it('provisions idempotently and commits exact ETB/USD capture and refund mappings', async () => {
    const { ledger: service, owner, runtime } = dependencies();
    const merchantId = await createMerchant(`mrc_ledger_valid_${randomUUID()}`);
    await runtime.getClient().$transaction(async (transaction) => {
      await service.provisionAccounts(transaction, merchantId);
    });
    expect(await owner.getClient().ledgerAccount.count({ where: { merchantId } })).toBe(8);

    const occurredAt = new Date('2026-08-02T13:00:00.000Z');
    const [capture, refund] = await Promise.all([
      runtime.getClient().$transaction((transaction) =>
        service.postCapture(transaction, {
          amountMinor: 125_000n,
          businessReference: 'pi_capture_valid',
          currency: 'ETB',
          merchantId,
          occurredAt,
          requestId: 'req_ledger_capture',
        }),
      ),
      runtime.getClient().$transaction((transaction) =>
        service.postRefund(transaction, {
          amountMinor: 5_000n,
          businessReference: 'rf_refund_valid',
          currency: 'USD',
          merchantId,
          occurredAt,
          requestId: 'req_ledger_refund',
        }),
      ),
    ]);

    expect(capture).toMatchObject({ businessType: 'capture', currency: 'ETB' });
    expect(refund).toMatchObject({ businessType: 'refund', currency: 'USD' });
    expect(capture.publicId).toMatch(/^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    const persisted = await owner.getClient().ledgerTransaction.findMany({
      include: { entries: { include: { account: true }, orderBy: { entrySeq: 'asc' } } },
      orderBy: { businessType: 'asc' },
      where: { merchantId },
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.every((transaction) => transaction.postedAt !== null)).toBe(true);
    const captureRow = persisted.find((transaction) => transaction.businessType === 'CAPTURE');
    const providerDebit = captureRow?.entries.find(
      (entry) => entry.account.code === 'provider_clearing',
    );
    const merchantCredit = captureRow?.entries.find(
      (entry) => entry.account.code === 'merchant_payable',
    );
    expect(providerDebit?.amountMinor).toBe(125_000n);
    expect(providerDebit?.side).toBe('DEBIT');
    expect(merchantCredit?.amountMinor).toBe(125_000n);
    expect(merchantCredit?.side).toBe('CREDIT');
    expect(await owner.getClient().auditEvent.count({ where: { merchantId } })).toBe(0);

    const fixedIdentifiers = {
      generate: (): string => capture.publicId.slice('ltx_'.length),
    } as unknown as MonotonicUlidGenerator;
    const collisionService = new LedgerService(
      new PrismaLedgerRepository(runtime),
      fixedIdentifiers,
    );
    await expect(
      runtime.getClient().$transaction((transaction) =>
        collisionService.postRefund(transaction, {
          amountMinor: 1n,
          businessReference: 'rf_forced_public_id_collision',
          currency: 'ETB',
          merchantId,
          occurredAt,
          requestId: 'req_forced_collision',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerIdentifierCollisionError);
    expect(
      await owner.getClient().ledgerTransaction.count({
        where: { businessReference: 'rf_forced_public_id_collision', merchantId },
      }),
    ).toBe(0);
  });

  it('rejects missing accounts, duplicate business effects, and rolls back caller work atomically', async () => {
    const { ledger: service, owner, runtime } = dependencies();
    const unprovisionedMerchantId = await createMerchant(
      `mrc_ledger_missing_${randomUUID()}`,
      false,
    );
    await expect(
      runtime.getClient().$transaction((transaction) =>
        service.postCapture(transaction, {
          amountMinor: 1n,
          businessReference: 'pi_missing_accounts',
          currency: 'ETB',
          merchantId: unprovisionedMerchantId,
          occurredAt: new Date(),
          requestId: 'req_missing_accounts',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerAccountsNotProvisionedError);

    const partialMerchantId = await createMerchant(`mrc_ledger_partial_${randomUUID()}`, false);
    await owner.getClient().ledgerAccount.createMany({
      data: [
        {
          code: 'provider_clearing',
          currency: 'ETB',
          merchantId: partialMerchantId,
          normalSide: 'DEBIT',
        },
        {
          code: 'merchant_payable',
          currency: 'ETB',
          merchantId: partialMerchantId,
          normalSide: 'CREDIT',
        },
      ],
    });
    await expect(
      runtime.getClient().$transaction((transaction) =>
        service.postCapture(transaction, {
          amountMinor: 1n,
          businessReference: 'pi_partial_accounts',
          currency: 'ETB',
          merchantId: partialMerchantId,
          occurredAt: new Date(),
          requestId: 'req_partial_accounts',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerAccountsNotProvisionedError);

    const merchantId = await createMerchant(`mrc_ledger_duplicate_${randomUUID()}`);
    const command = {
      amountMinor: 20n,
      businessReference: 'pi_duplicate_effect',
      currency: 'ETB' as const,
      merchantId,
      occurredAt: new Date('2026-08-02T14:00:00.000Z'),
      requestId: 'req_duplicate_effect',
    };
    const outcomes = await Promise.allSettled([
      runtime.getClient().$transaction((transaction) => service.postCapture(transaction, command)),
      runtime.getClient().$transaction((transaction) => service.postCapture(transaction, command)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    const rejectionReason: unknown = rejected?.status === 'rejected' ? rejected.reason : undefined;
    expect(rejectionReason).toBeInstanceOf(LedgerBusinessReferenceConflictError);
    expect(
      await owner.getClient().ledgerTransaction.count({
        where: { businessReference: command.businessReference, merchantId },
      }),
    ).toBe(1);

    await expect(
      runtime.getClient().$transaction(async (transaction) => {
        await service.postRefund(transaction, {
          ...command,
          businessReference: 'rf_atomic_rollback',
          requestId: 'req_atomic_rollback',
        });
        await transaction.paymentIntent.create({
          data: {
            amountMinor: 1n,
            captureMethod: 'MANUAL',
            currency: 'ETB',
            externalRef: 'ledger-rollback-sentinel',
            merchantId,
            publicId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAD',
          },
        });
        throw new Error('injected caller failure');
      }),
    ).rejects.toThrow('injected caller failure');
    expect(
      await owner.getClient().ledgerTransaction.count({
        where: { businessReference: 'rf_atomic_rollback', merchantId },
      }),
    ).toBe(0);
    expect(
      await owner.getClient().paymentIntent.count({
        where: { externalRef: 'ledger-rollback-sentinel', merchantId },
      }),
    ).toBe(0);
  });

  it('enforces deferred balance, finalization, tenant/currency, and immutability controls', async () => {
    const { owner, runtime } = dependencies();
    const merchantId = await createMerchant(`mrc_ledger_constraints_${randomUUID()}`);
    const otherMerchantId = await createMerchant(`mrc_ledger_other_${randomUUID()}`);
    const accounts = await owner.getClient().ledgerAccount.findMany({ where: { merchantId } });
    const debitAccount = accounts.find(
      (account) => account.code === 'provider_clearing' && account.currency === 'ETB',
    );
    const creditAccount = accounts.find(
      (account) => account.code === 'merchant_payable' && account.currency === 'ETB',
    );
    if (debitAccount === undefined || creditAccount === undefined) {
      throw new Error('Ledger test accounts are missing');
    }

    const invalidAmountTransactionId = randomUUID();
    await expect(
      owner.getClient().$transaction(async (transaction) => {
        await transaction.ledgerTransaction.create({
          data: {
            businessReference: 'invalid-amount',
            businessType: 'CAPTURE',
            currency: 'ETB',
            id: invalidAmountTransactionId,
            merchantId,
            occurredAt: new Date(),
            publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAF',
            requestId: 'req_invalid_amount',
          },
        });
        await transaction.ledgerEntry.create({
          data: {
            accountId: debitAccount.id,
            amountMinor: 0n,
            currency: 'ETB',
            entrySeq: 1,
            id: randomUUID(),
            ledgerTransactionId: invalidAmountTransactionId,
            merchantId,
            side: 'DEBIT',
          },
        });
      }),
    ).rejects.toThrow('ledger_entries_amount_minor_range_check');

    const singleEntryTransactionId = randomUUID();
    await expect(
      owner.getClient().$transaction(async (transaction) => {
        await transaction.ledgerTransaction.create({
          data: {
            businessReference: 'single-entry',
            businessType: 'CAPTURE',
            currency: 'ETB',
            id: singleEntryTransactionId,
            merchantId,
            occurredAt: new Date(),
            publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAG',
            requestId: 'req_single_entry',
          },
        });
        await transaction.ledgerEntry.create({
          data: {
            accountId: debitAccount.id,
            amountMinor: 1n,
            currency: 'ETB',
            entrySeq: 1,
            id: randomUUID(),
            ledgerTransactionId: singleEntryTransactionId,
            merchantId,
            side: 'DEBIT',
          },
        });
        await transaction.$executeRaw`UPDATE ledger_transactions SET posted_at = transaction_timestamp() WHERE id = ${singleEntryTransactionId}::uuid`;
      }),
    ).rejects.toThrow('ledger transaction requires at least two entries');

    const invalidTransactionId = randomUUID();
    await expect(
      owner.getClient().$transaction(async (transaction) => {
        await transaction.ledgerTransaction.create({
          data: {
            businessReference: 'unbalanced',
            businessType: 'CAPTURE',
            currency: 'ETB',
            id: invalidTransactionId,
            merchantId,
            occurredAt: new Date(),
            publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAA',
            requestId: 'req_unbalanced',
          },
        });
        await transaction.ledgerEntry.createMany({
          data: [
            {
              accountId: debitAccount.id,
              amountMinor: 10n,
              currency: 'ETB',
              entrySeq: 1,
              id: randomUUID(),
              ledgerTransactionId: invalidTransactionId,
              merchantId,
              side: 'DEBIT',
            },
            {
              accountId: creditAccount.id,
              amountMinor: 9n,
              currency: 'ETB',
              entrySeq: 2,
              id: randomUUID(),
              ledgerTransactionId: invalidTransactionId,
              merchantId,
              side: 'CREDIT',
            },
          ],
        });
        await transaction.$executeRaw`UPDATE ledger_transactions SET posted_at = transaction_timestamp() WHERE id = ${invalidTransactionId}::uuid`;
      }),
    ).rejects.toThrow('ledger transaction debits and credits must balance');

    await expect(
      owner.getClient().ledgerTransaction.create({
        data: {
          businessReference: 'unfinalized',
          businessType: 'CAPTURE',
          currency: 'ETB',
          merchantId,
          occurredAt: new Date(),
          publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAB',
          requestId: 'req_unfinalized',
        },
      }),
    ).rejects.toThrow('ledger transaction must be finalized before commit');

    const otherAccount = await owner.getClient().ledgerAccount.findFirstOrThrow({
      where: { code: 'merchant_payable', currency: 'ETB', merchantId: otherMerchantId },
    });
    const crossTenantTransactionId = randomUUID();
    await expect(
      owner.getClient().$transaction(async (transaction) => {
        await transaction.ledgerTransaction.create({
          data: {
            businessReference: 'cross-tenant',
            businessType: 'CAPTURE',
            currency: 'ETB',
            id: crossTenantTransactionId,
            merchantId,
            occurredAt: new Date(),
            publicId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAC',
            requestId: 'req_cross_tenant',
          },
        });
        await transaction.ledgerEntry.createMany({
          data: [
            {
              accountId: debitAccount.id,
              amountMinor: 10n,
              currency: 'ETB',
              entrySeq: 1,
              id: randomUUID(),
              ledgerTransactionId: crossTenantTransactionId,
              merchantId,
              side: 'DEBIT',
            },
            {
              accountId: otherAccount.id,
              amountMinor: 10n,
              currency: 'ETB',
              entrySeq: 2,
              id: randomUUID(),
              ledgerTransactionId: crossTenantTransactionId,
              merchantId,
              side: 'CREDIT',
            },
          ],
        });
        await transaction.$executeRaw`UPDATE ledger_transactions SET posted_at = transaction_timestamp() WHERE id = ${crossTenantTransactionId}::uuid`;
      }),
    ).rejects.toThrow(
      'ledger entry merchant or currency does not match its transaction and account',
    );

    const valid = await runtime.getClient().$transaction((transaction) =>
      dependencies().ledger.postCapture(transaction, {
        amountMinor: 11n,
        businessReference: 'pi_immutable',
        currency: 'ETB',
        merchantId,
        occurredAt: new Date(),
        requestId: 'req_immutable',
      }),
    );
    const stored = await owner.getClient().ledgerTransaction.findUniqueOrThrow({
      include: { entries: true },
      where: { publicId: valid.publicId },
    });
    const firstEntry = stored.entries[0];
    if (firstEntry === undefined) throw new Error('Expected a Ledger entry');
    await expect(
      owner.getClient().ledgerEntry.update({
        data: { amountMinor: 12n },
        where: { id: firstEntry.id },
      }),
    ).rejects.toThrow('ledger accounts and entries are immutable');
    await expect(
      owner.getClient().ledgerTransaction.update({
        data: { businessReference: 'mutated' },
        where: { id: stored.id },
      }),
    ).rejects.toThrow('posted ledger transactions are immutable');
    await expect(
      owner.getClient().ledgerAccount.update({
        data: { currency: 'USD' },
        where: { id: debitAccount.id },
      }),
    ).rejects.toThrow('ledger accounts and entries are immutable');
    await expect(
      owner.getClient().ledgerTransaction.delete({ where: { id: stored.id } }),
    ).rejects.toThrow('posted ledger transactions are immutable');
    await expect(
      owner.getClient().$executeRawUnsafe('TRUNCATE TABLE ledger_entries'),
    ).rejects.toThrow('ledger tables cannot be truncated');
    await expect(
      runtime.getClient().ledgerEntry.delete({ where: { id: firstEntry.id } }),
    ).rejects.toThrow();
  });

  it('creates one exact tenant-scoped reversal and rejects concurrent duplicates and chains', async () => {
    const { ledger: service, owner, runtime } = dependencies();
    const merchantId = await createMerchant(`mrc_ledger_reversal_${randomUUID()}`);
    const original = await runtime.getClient().$transaction((transaction) =>
      service.postCapture(transaction, {
        amountMinor: 33n,
        businessReference: 'pi_reversal_original',
        currency: 'USD',
        merchantId,
        occurredAt: new Date('2026-08-02T15:00:00.000Z'),
        requestId: 'req_reversal_original',
      }),
    );
    const reversalOutcomes = await Promise.allSettled([
      runtime.getClient().$transaction((transaction) =>
        service.reverse(transaction, {
          businessReference: 'rv_reversal_one',
          merchantId,
          occurredAt: new Date('2026-08-02T15:01:00.000Z'),
          originalPublicId: original.publicId,
          requestId: 'req_reversal_one',
        }),
      ),
      runtime.getClient().$transaction((transaction) =>
        service.reverse(transaction, {
          businessReference: 'rv_reversal_two',
          merchantId,
          occurredAt: new Date('2026-08-02T15:02:00.000Z'),
          originalPublicId: original.publicId,
          requestId: 'req_reversal_two',
        }),
      ),
    ]);
    expect(reversalOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = reversalOutcomes.find((outcome) => outcome.status === 'rejected');
    const rejectionReason: unknown = rejected?.status === 'rejected' ? rejected.reason : undefined;
    expect(rejectionReason).toBeInstanceOf(LedgerReversalConflictError);

    const persisted = await owner.getClient().ledgerTransaction.findMany({
      include: { entries: { orderBy: { entrySeq: 'asc' } } },
      where: { merchantId },
    });
    const originalRow = persisted.find((transaction) => transaction.businessType === 'CAPTURE');
    const reversalRow = persisted.find((transaction) => transaction.businessType === 'REVERSAL');
    expect(reversalRow?.reversalOfId).toBe(originalRow?.id);
    if (originalRow === undefined || reversalRow === undefined) {
      throw new Error('Expected original and reversal rows');
    }
    expect(reversalRow.entries).toHaveLength(originalRow.entries.length);
    for (const originalEntry of originalRow.entries) {
      const reversedEntry = reversalRow.entries.find(
        (entry) => entry.entrySeq === originalEntry.entrySeq,
      );
      expect(reversedEntry?.accountId).toBe(originalEntry.accountId);
      expect(reversedEntry?.amountMinor).toBe(originalEntry.amountMinor);
      expect(reversedEntry?.side).toBe(originalEntry.side === 'DEBIT' ? 'CREDIT' : 'DEBIT');
    }
    await expect(
      runtime.getClient().$transaction((transaction) =>
        service.reverse(transaction, {
          businessReference: 'rv_reversal_chain',
          merchantId,
          occurredAt: new Date(),
          originalPublicId: reversalRow.publicId,
          requestId: 'req_reversal_chain',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerReversalConflictError);

    const otherMerchantId = await createMerchant(`mrc_ledger_reversal_other_${randomUUID()}`);
    await expect(
      runtime.getClient().$transaction((transaction) =>
        service.reverse(transaction, {
          businessReference: 'rv_cross_tenant',
          merchantId: otherMerchantId,
          occurredAt: new Date(),
          originalPublicId: original.publicId,
          requestId: 'req_cross_tenant_reversal',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerTransactionNotFoundError);
  });

  it('installs named deferred triggers and least-privilege runtime grants', async () => {
    const { postgres: container } = dependencies();
    const triggers = await executeSql(
      container,
      container.getDatabase(),
      `SELECT tgname || '|' || tgdeferrable || '|' || tginitdeferred
       FROM pg_trigger
       WHERE tgrelid IN ('ledger_transactions'::regclass, 'ledger_entries'::regclass)
         AND NOT tgisinternal
       ORDER BY tgname;`,
    );
    expect(triggers).toContain('ledger_entries_integrity_trigger|true|true');
    expect(triggers).toContain('ledger_transactions_integrity_trigger|true|true');

    const constraints = await executeSql(
      container,
      container.getDatabase(),
      `SELECT conname FROM pg_constraint
       WHERE conrelid IN (
         'ledger_accounts'::regclass,
         'ledger_transactions'::regclass,
         'ledger_entries'::regclass
       ) ORDER BY conname;`,
    );
    expect(constraints.split(/\r?\n/u)).toEqual(
      expect.arrayContaining([
        'ledger_accounts_code_normal_side_check',
        'ledger_accounts_code_allowlist_check',
        'ledger_entries_amount_minor_range_check',
        'ledger_entries_transaction_id_merchant_id_currency_fkey',
        'ledger_transactions_business_reference_check',
        'ledger_transactions_reversal_of_id_merchant_id_currency_fkey',
      ]),
    );

    const functionSearchPaths = await executeSql(
      container,
      container.getDatabase(),
      `SELECT proname || '|' || array_to_string(proconfig, ',')
       FROM pg_proc
       WHERE proname LIKE 'settleflow_%ledger%'
       ORDER BY proname;`,
    );
    expect(
      functionSearchPaths
        .split(/\r?\n/u)
        .every((line) => line.includes('search_path=pg_catalog, public')),
    ).toBe(true);

    const grants = await executeSql(
      container,
      container.getDatabase(),
      `SELECT table_name || '|' || string_agg(privilege_type, ',' ORDER BY privilege_type)
       FROM information_schema.role_table_grants
       WHERE grantee = 'settleflow_app' AND table_name LIKE 'ledger_%'
       GROUP BY table_name ORDER BY table_name;`,
    );
    expect(grants.split(/\r?\n/u)).toEqual([
      'ledger_accounts|INSERT,SELECT',
      'ledger_entries|INSERT,SELECT',
      'ledger_transactions|INSERT,SELECT,UPDATE',
    ]);

    const columns = await executeSql(
      container,
      container.getDatabase(),
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ledger_accounts'
       ORDER BY column_name;`,
    );
    expect(columns.split(/\r?\n/u)).not.toContain('balance');
  });
});
