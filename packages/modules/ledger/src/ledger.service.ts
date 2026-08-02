import { randomUUID } from 'node:crypto';

import { MonotonicUlidGenerator, type PrismaTransactionClient } from '@settleflow/infrastructure';

import {
  InvalidLedgerCommandError,
  LedgerAccountsNotProvisionedError,
  LedgerBusinessReferenceConflictError,
  LedgerIdentifierCollisionError,
  LedgerInvariantViolationError,
  LedgerReversalConflictError,
  LedgerTransactionNotFoundError,
} from './ledger.errors';
import { buildCaptureEntries, buildRefundEntries, buildReversalEntries } from './ledger-posting';
import type {
  CreateLedgerPostingRecord,
  LedgerAccountProvisioningResult,
  LedgerBusinessType,
  LedgerMoneyPostingCommand,
  LedgerObservation,
  LedgerObserver,
  LedgerPostingPort,
  LedgerPostingResult,
  LedgerRepository,
  ProvisionLedgerAccountRecord,
  ReverseLedgerTransactionCommand,
} from './ledger.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const LEDGER_ID_PATTERN = /^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

const ACCOUNT_DEFINITIONS = [
  { code: 'provider_clearing', normalSide: 'debit' },
  { code: 'merchant_payable', normalSide: 'credit' },
] as const;
const CURRENCIES = ['ETB', 'USD'] as const;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function assertIdentity(merchantId: string): void {
  if (!UUID_PATTERN.test(merchantId)) {
    throw new InvalidLedgerCommandError();
  }
}

function assertCommonCommand(command: {
  readonly businessReference: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
}): void {
  assertIdentity(command.merchantId);
  if (
    command.businessReference.length < 1 ||
    command.businessReference.length > 255 ||
    command.businessReference.trim() !== command.businessReference ||
    containsControlCharacter(command.businessReference) ||
    !REQUEST_ID_PATTERN.test(command.requestId) ||
    !Number.isFinite(command.occurredAt.getTime())
  ) {
    throw new InvalidLedgerCommandError();
  }
}

function assertMoneyCommand(command: LedgerMoneyPostingCommand): void {
  assertCommonCommand(command);
  if (
    (command.currency !== 'ETB' && command.currency !== 'USD') ||
    command.amountMinor < 1n ||
    command.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidLedgerCommandError();
  }
}

function errorCode(error: unknown): string {
  if (error instanceof InvalidLedgerCommandError) return 'invalid_command';
  if (error instanceof LedgerAccountsNotProvisionedError) return 'accounts_not_provisioned';
  if (error instanceof LedgerBusinessReferenceConflictError) return 'business_reference_conflict';
  if (error instanceof LedgerIdentifierCollisionError) return 'identifier_collision';
  if (error instanceof LedgerInvariantViolationError) return 'invariant_violation';
  if (error instanceof LedgerReversalConflictError) return 'reversal_conflict';
  if (error instanceof LedgerTransactionNotFoundError) return 'transaction_not_found';
  return 'internal_error';
}

export class LedgerService implements LedgerPostingPort {
  public constructor(
    private readonly repository: LedgerRepository,
    private readonly identifiers: MonotonicUlidGenerator,
    private readonly observer?: LedgerObserver,
    private readonly uuid: () => string = randomUUID,
  ) {}

  public async provisionAccounts(
    transaction: PrismaTransactionClient,
    merchantId: string,
  ): Promise<LedgerAccountProvisioningResult> {
    assertIdentity(merchantId);
    const accounts: ProvisionLedgerAccountRecord[] = [];
    for (const currency of CURRENCIES) {
      for (const definition of ACCOUNT_DEFINITIONS) {
        accounts.push({
          code: definition.code,
          currency,
          id: this.uuid(),
          merchantId,
          normalSide: definition.normalSide,
        });
      }
    }
    const persisted = await this.repository.provisionAccounts(transaction, accounts);
    if (persisted.length !== 4) {
      throw new LedgerAccountsNotProvisionedError();
    }
    return { accounts: persisted, merchantId };
  }

  public postCapture(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult> {
    return this.post(transaction, command, 'capture');
  }

  public postRefund(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
  ): Promise<LedgerPostingResult> {
    return this.post(transaction, command, 'refund');
  }

  public async reverse(
    transaction: PrismaTransactionClient,
    command: ReverseLedgerTransactionCommand,
  ): Promise<LedgerPostingResult> {
    const businessType: LedgerBusinessType = 'reversal';
    let publicId: string | undefined;
    try {
      assertCommonCommand(command);
      if (!LEDGER_ID_PATTERN.test(command.originalPublicId)) {
        throw new InvalidLedgerCommandError();
      }
      const original = await this.repository.findPostedForReversal(
        transaction,
        command.merchantId,
        command.originalPublicId,
      );
      if (original === undefined) {
        throw new LedgerTransactionNotFoundError();
      }
      if (original.businessType === 'reversal') {
        throw new LedgerReversalConflictError();
      }
      publicId = `ltx_${this.identifiers.generate(command.occurredAt.getTime())}`;
      const input: CreateLedgerPostingRecord = {
        businessReference: command.businessReference,
        businessType,
        currency: original.currency,
        entries: buildReversalEntries(original.entries).map((entry) => ({
          ...entry,
          id: this.uuid(),
        })),
        id: this.uuid(),
        merchantId: command.merchantId,
        occurredAt: command.occurredAt,
        publicId,
        requestId: command.requestId,
        reversalOfId: original.internalId,
        reversalOfPublicId: original.publicId,
      };
      const result = await this.repository.createPosting(transaction, input);
      this.observe({
        businessType,
        merchantId: command.merchantId,
        name: 'ledger.post',
        outcome: 'staged',
        publicId,
      });
      return result;
    } catch (error: unknown) {
      this.observe({
        businessType,
        errorCode: errorCode(error),
        merchantId: command.merchantId,
        name: 'ledger.post',
        outcome: 'rejected',
        ...(publicId === undefined ? {} : { publicId }),
      });
      throw error;
    }
  }

  private async post(
    transaction: PrismaTransactionClient,
    command: LedgerMoneyPostingCommand,
    businessType: Exclude<LedgerBusinessType, 'reversal'>,
  ): Promise<LedgerPostingResult> {
    let publicId: string | undefined;
    try {
      assertMoneyCommand(command);
      publicId = `ltx_${this.identifiers.generate(command.occurredAt.getTime())}`;
      const entries = (
        businessType === 'capture'
          ? buildCaptureEntries(command.amountMinor, command.currency)
          : buildRefundEntries(command.amountMinor, command.currency)
      ).map((entry) => ({ ...entry, id: this.uuid() }));
      const result = await this.repository.createPosting(transaction, {
        businessReference: command.businessReference,
        businessType,
        currency: command.currency,
        entries,
        id: this.uuid(),
        merchantId: command.merchantId,
        occurredAt: command.occurredAt,
        publicId,
        requestId: command.requestId,
      });
      this.observe({
        businessType,
        merchantId: command.merchantId,
        name: 'ledger.post',
        outcome: 'staged',
        publicId,
      });
      return result;
    } catch (error: unknown) {
      this.observe({
        businessType,
        errorCode: errorCode(error),
        merchantId: command.merchantId,
        name: 'ledger.post',
        outcome: 'rejected',
        ...(publicId === undefined ? {} : { publicId }),
      });
      throw error;
    }
  }

  private observe(observation: LedgerObservation): void {
    try {
      this.observer?.record(observation);
    } catch {
      // Telemetry is optional and must never decide a financial transaction.
    }
  }
}

export const ledgerServiceInternals = {
  ACCOUNT_DEFINITIONS,
  CURRENCIES,
  LEDGER_ID_PATTERN,
  assertCommonCommand,
  assertMoneyCommand,
  errorCode,
};
