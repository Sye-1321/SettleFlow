import { calculateFullJitterBackoff } from './outbox-retry';
import type {
  OutboxFinalization,
  OutboxPublisher,
  OutboxPublishFailureCode,
  OutboxRelayOptions,
  OutboxRelayRepository,
  OutboxRelayRunResult,
} from './outbox-relay.types';

export class OutboxRelayService {
  private readonly random: () => number;
  private readonly signal: NonNullable<OutboxRelayOptions['signal']>;

  public constructor(
    private readonly repository: OutboxRelayRepository,
    private readonly publisher: OutboxPublisher,
    private readonly options: OutboxRelayOptions,
  ) {
    this.random = options.random ?? Math.random;
    this.signal = options.signal ?? ((): void => undefined);
  }

  public async runOnce(workerId: string): Promise<OutboxRelayRunResult> {
    if (!(await this.publisher.ensureReady())) {
      return {
        claimed: 0,
        ownershipLost: 0,
        published: 0,
        publisherReady: false,
        retryScheduled: 0,
      };
    }

    const claimed = await this.repository.claimPending({
      batchSize: this.options.batchSize,
      workerId,
    });
    if (claimed.length === 0) {
      return {
        claimed: 0,
        ownershipLost: 0,
        published: 0,
        publisherReady: true,
        retryScheduled: 0,
      };
    }

    const outcomes = await this.publisher.publishBatch(claimed);
    const confirmedCount = outcomes.filter((outcome) => outcome.kind === 'confirmed').length;
    if (confirmedCount > 0) {
      this.signal({ count: confirmedCount, event: 'outbox.publish.confirmed' });
    }
    const failureCounts: Partial<Record<OutboxPublishFailureCode, number>> = {};
    for (const outcome of outcomes) {
      if (outcome.kind === 'retry') {
        failureCounts[outcome.code] = (failureCounts[outcome.code] ?? 0) + 1;
      }
    }
    const outcomeEventIds = new Set(outcomes.map((outcome) => outcome.eventId));
    const missingOutcomeCount = claimed.filter(
      (event) => !outcomeEventIds.has(event.eventId),
    ).length;
    if (missingOutcomeCount > 0) {
      failureCounts.publisher_unavailable =
        (failureCounts.publisher_unavailable ?? 0) + missingOutcomeCount;
    }
    const returnedCount = failureCounts.mandatory_return ?? 0;
    if (returnedCount > 0) {
      this.signal({ count: returnedCount, event: 'outbox.publish.returned' });
    }
    const outcomesByEventId = new Map(outcomes.map((outcome) => [outcome.eventId, outcome]));
    const finalizations: OutboxFinalization[] = claimed.map((event) => {
      const outcome = outcomesByEventId.get(event.eventId);
      if (outcome?.kind === 'confirmed') {
        return { eventId: event.eventId, id: event.id, kind: 'published' };
      }

      return {
        eventId: event.eventId,
        id: event.id,
        kind: 'retry',
        retryDelayMs: calculateFullJitterBackoff({
          attemptCount: event.attemptCount,
          baseMs: this.options.retryBaseMs,
          maxMs: this.options.retryMaxMs,
          random: this.random,
        }),
      };
    });
    const finalized = await this.repository.finalize({ events: finalizations, workerId });
    const published = finalizations.filter((event) => event.kind === 'published').length;
    const retryScheduled = finalizations.length - published;
    if (retryScheduled > 0) {
      this.signal({
        count: retryScheduled,
        event: 'outbox.publish.retry_scheduled',
        failureCounts,
      });
    }

    return {
      claimed: claimed.length,
      ownershipLost: finalized.ownershipLost,
      published,
      publisherReady: this.publisher.isReady(),
      retryScheduled,
    };
  }
}
