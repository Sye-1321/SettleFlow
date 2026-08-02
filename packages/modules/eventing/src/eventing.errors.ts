export class EventIdentifierCollisionError extends Error {
  public constructor() {
    super('The generated event identifier collided with an existing event');
    this.name = 'EventIdentifierCollisionError';
  }
}

export class PermanentMessageProcessingError extends Error {
  public constructor(public readonly code: string) {
    super('The message cannot be processed safely without operator review');
    this.name = 'PermanentMessageProcessingError';
  }
}

export class InboxMessageConflictError extends PermanentMessageProcessingError {
  public constructor() {
    super('inbox_message_identity_conflict');
    this.name = 'InboxMessageConflictError';
  }
}

export class MessageTransactionRetryExhaustedError extends PermanentMessageProcessingError {
  public constructor() {
    super('projection_transaction_retry_exhausted');
    this.name = 'MessageTransactionRetryExhaustedError';
  }
}
