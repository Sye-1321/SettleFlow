import { OutboxRelayService } from './outbox-relay.service';
import type {
  ClaimedOutboxEvent,
  OutboxPublisher,
  OutboxRelayRepository,
} from './outbox-relay.types';
import { calculateFullJitterBackoff } from './outbox-retry';

const claimedEvents: readonly ClaimedOutboxEvent[] = [
  {
    aggregateId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    aggregateType: 'payment_intent',
    attemptCount: 3,
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    eventType: 'payment.created.v1',
    id: '11111111-1111-4111-8111-111111111111',
    merchantId: '22222222-2222-4222-8222-222222222222',
    occurredAt: new Date('2026-08-01T10:20:12.345Z'),
    payload: {},
    requestId: 'req_one',
  },
  {
    aggregateId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    aggregateType: 'payment_intent',
    attemptCount: 1,
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    eventType: 'payment.created.v1',
    id: '33333333-3333-4333-8333-333333333333',
    merchantId: '22222222-2222-4222-8222-222222222222',
    occurredAt: new Date('2026-08-01T10:20:13.345Z'),
    payload: {},
    requestId: 'req_two',
  },
];

describe('OutboxRelayService', () => {
  it('does not claim when the confirmed publisher topology is unavailable', async () => {
    const claimPending = jest.fn();
    const repository: jest.Mocked<OutboxRelayRepository> = {
      claimPending,
      finalize: jest.fn(),
    };
    const publisher: jest.Mocked<OutboxPublisher> = {
      close: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(false),
      isReady: jest.fn().mockReturnValue(false),
      publishBatch: jest.fn(),
    };

    const result = await new OutboxRelayService(repository, publisher, {
      batchSize: 50,
      random: (): number => 0.5,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    }).runOnce('worker_one');

    expect(result).toEqual({
      claimed: 0,
      ownershipLost: 0,
      published: 0,
      publisherReady: false,
      retryScheduled: 0,
    });
    expect(claimPending).not.toHaveBeenCalled();
  });

  it('finalizes confirmed messages and schedules every other claim for retry', async () => {
    const finalize = jest.fn().mockResolvedValue({ ownershipLost: 0, updated: 2 });
    const repository: jest.Mocked<OutboxRelayRepository> = {
      claimPending: jest.fn().mockResolvedValue(claimedEvents),
      finalize,
    };
    const publisher: jest.Mocked<OutboxPublisher> = {
      close: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
      publishBatch: jest.fn().mockResolvedValue([
        { eventId: claimedEvents[0]?.eventId, kind: 'confirmed' },
        {
          code: 'confirm_timeout',
          eventId: claimedEvents[1]?.eventId,
          kind: 'retry',
        },
      ]),
    };

    const result = await new OutboxRelayService(repository, publisher, {
      batchSize: 50,
      random: (): number => 0.5,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    }).runOnce('worker_one');

    expect(finalize).toHaveBeenCalledWith({
      events: [
        {
          eventId: claimedEvents[0]?.eventId,
          id: claimedEvents[0]?.id,
          kind: 'published',
        },
        {
          eventId: claimedEvents[1]?.eventId,
          id: claimedEvents[1]?.id,
          kind: 'retry',
          retryDelayMs: 500,
        },
      ],
      workerId: 'worker_one',
    });
    expect(result).toEqual({
      claimed: 2,
      ownershipLost: 0,
      published: 1,
      publisherReady: true,
      retryScheduled: 1,
    });
  });

  it('uses inclusive capped full-jitter bounds without overflowing', () => {
    expect(
      calculateFullJitterBackoff({
        attemptCount: 1,
        baseMs: 1_000,
        maxMs: 60_000,
        random: () => 0,
      }),
    ).toBe(0);
    expect(
      calculateFullJitterBackoff({
        attemptCount: 100,
        baseMs: 1_000,
        maxMs: 60_000,
        random: () => 1,
      }),
    ).toBe(60_000);
  });
});
