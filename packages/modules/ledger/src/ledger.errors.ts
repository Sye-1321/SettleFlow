export class InvalidLedgerCommandError extends Error {
  public constructor() {
    super('The ledger command is invalid');
    this.name = 'InvalidLedgerCommandError';
  }
}

export class LedgerAccountsNotProvisionedError extends Error {
  public constructor() {
    super('The approved ledger accounts are not provisioned');
    this.name = 'LedgerAccountsNotProvisionedError';
  }
}

export class LedgerIdentifierCollisionError extends Error {
  public constructor() {
    super('The ledger transaction identifier is unavailable');
    this.name = 'LedgerIdentifierCollisionError';
  }
}

export class LedgerBusinessReferenceConflictError extends Error {
  public constructor() {
    super('The ledger business reference already has a posting');
    this.name = 'LedgerBusinessReferenceConflictError';
  }
}

export class LedgerReversalConflictError extends Error {
  public constructor() {
    super('The ledger transaction cannot be reversed');
    this.name = 'LedgerReversalConflictError';
  }
}

export class LedgerTransactionNotFoundError extends Error {
  public constructor() {
    super('The ledger transaction was not found');
    this.name = 'LedgerTransactionNotFoundError';
  }
}

export class LedgerInvariantViolationError extends Error {
  public constructor() {
    super('A ledger invariant rejected the posting');
    this.name = 'LedgerInvariantViolationError';
  }
}
