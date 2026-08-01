export interface ClaimedOutboxEvent {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly attemptCount: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly id: string;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
  readonly requestId: string;
}

export interface ClaimPendingOutboxInput {
  readonly batchSize: number;
  readonly workerId: string;
}

export type OutboxPublishOutcome =
  | {
      readonly eventId: string;
      readonly kind: 'confirmed';
    }
  | {
      readonly code:
        | 'channel_backpressure_timeout'
        | 'confirm_nack'
        | 'confirm_timeout'
        | 'event_contract_invalid'
        | 'mandatory_return'
        | 'publisher_unavailable';
      readonly eventId: string;
      readonly kind: 'retry';
    };

export type OutboxPublishFailureCode = Extract<
  OutboxPublishOutcome,
  { readonly kind: 'retry' }
>['code'];

export interface OutboxRelaySignal {
  readonly code?: string;
  readonly count?: number;
  readonly durationMs?: number;
  readonly event:
    | 'outbox.claim.completed'
    | 'outbox.finalize.completed'
    | 'outbox.finalize.ownership_lost'
    | 'outbox.publish.confirmed'
    | 'outbox.publish.returned'
    | 'outbox.publish.retry_scheduled'
    | 'outbox.relay.dependency_unavailable'
    | 'outbox.relay.started'
    | 'outbox.relay.stopped'
    | 'outbox.relay.stopping'
    | 'outbox.topology.failed'
    | 'outbox.topology.ready';
  readonly failureCounts?: Partial<Record<OutboxPublishFailureCode, number>>;
}

export type OutboxRelaySignalSink = (signal: OutboxRelaySignal) => void;

export type OutboxFinalization =
  | {
      readonly eventId: string;
      readonly id: string;
      readonly kind: 'published';
    }
  | {
      readonly eventId: string;
      readonly id: string;
      readonly kind: 'retry';
      readonly retryDelayMs: number;
    };

export interface FinalizeOutboxInput {
  readonly events: readonly OutboxFinalization[];
  readonly workerId: string;
}

export interface FinalizeOutboxResult {
  readonly ownershipLost: number;
  readonly updated: number;
}

export interface OutboxRelayRepository {
  claimPending(input: ClaimPendingOutboxInput): Promise<readonly ClaimedOutboxEvent[]>;
  finalize(input: FinalizeOutboxInput): Promise<FinalizeOutboxResult>;
}

export interface OutboxPublisher {
  close(): Promise<void>;
  ensureReady(): Promise<boolean>;
  isReady(): boolean;
  publishBatch(events: readonly ClaimedOutboxEvent[]): Promise<readonly OutboxPublishOutcome[]>;
}

export interface OutboxRelayOptions {
  readonly batchSize: number;
  readonly random?: () => number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly signal?: OutboxRelaySignalSink;
}

export interface OutboxRelayRunResult {
  readonly claimed: number;
  readonly ownershipLost: number;
  readonly published: number;
  readonly publisherReady: boolean;
  readonly retryScheduled: number;
}
