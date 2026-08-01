import { EventEmitter } from 'node:events';
import type { ChannelModel, ConfirmChannel, Options, Replies } from 'amqplib';

import type { ClaimedOutboxEvent } from './outbox-relay.types';
import {
  OUTBOX_RABBITMQ_TOPOLOGY,
  RabbitMqOutboxPublisher,
  type RabbitMqConnector,
} from './rabbitmq-outbox.publisher';

const EVENT: ClaimedOutboxEvent = {
  aggregateId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  aggregateType: 'payment_intent',
  attemptCount: 2,
  eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  eventType: 'payment.created.v1',
  id: '11111111-1111-4111-8111-111111111111',
  merchantId: '22222222-2222-4222-8222-222222222222',
  occurredAt: new Date('2026-08-01T10:20:12.345Z'),
  payload: {
    amountMinor: 125_000,
    currency: 'USD',
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    eventType: 'payment.created.v1',
    merchantId: '22222222-2222-4222-8222-222222222222',
    occurredAt: '2026-08-01T10:20:12.345Z',
    paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_publisher_test',
    status: 'CREATED',
  },
  requestId: 'req_publisher_test',
};

const SECOND_EVENT: ClaimedOutboxEvent = {
  ...EVENT,
  aggregateId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  id: '33333333-3333-4333-8333-333333333333',
  payload: {
    ...(EVENT.payload as Readonly<Record<string, unknown>>),
    eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    paymentId: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAW',
  },
};

type ConfirmCallback = (error: unknown, ok: Replies.Empty) => void;

interface FakeBroker {
  readonly assertExchange: jest.Mock;
  readonly assertQueue: jest.Mock;
  readonly bindQueue: jest.Mock;
  readonly channel: ConfirmChannel;
  readonly closeChannel: jest.Mock;
  readonly closeConnection: jest.Mock;
  readonly connector: RabbitMqConnector;
  readonly publish: jest.Mock;
}

function createFakeBroker(
  publishBehavior: (channel: EventEmitter, callback: ConfirmCallback) => void,
  writeAccepted = true,
): FakeBroker {
  const channelEvents = new EventEmitter();
  const connectionEvents = new EventEmitter();
  const assertExchange = jest.fn().mockResolvedValue({ exchange: '' });
  const assertQueue = jest.fn().mockResolvedValue({ consumerCount: 0, messageCount: 0, queue: '' });
  const bindQueue = jest.fn().mockResolvedValue({});
  const closeChannel = jest.fn().mockResolvedValue(undefined);
  const closeConnection = jest.fn().mockResolvedValue(undefined);
  const publish = jest.fn(
    (
      _exchange: string,
      _routingKey: string,
      _content: Buffer,
      _options: Options.Publish,
      callback: ConfirmCallback,
    ): boolean => {
      publishBehavior(channelEvents, callback);
      return writeAccepted;
    },
  );
  const channel = Object.assign(channelEvents, {
    assertExchange,
    assertQueue,
    bindQueue,
    close: closeChannel,
    publish,
  }) as unknown as ConfirmChannel;
  const connection = Object.assign(connectionEvents, {
    close: closeConnection,
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
  }) as unknown as ChannelModel;

  return {
    assertExchange,
    assertQueue,
    bindQueue,
    channel,
    closeChannel,
    closeConnection,
    connector: jest.fn().mockResolvedValue(connection) as RabbitMqConnector,
    publish,
  };
}

function createPublisher(broker: FakeBroker): RabbitMqOutboxPublisher {
  return new RabbitMqOutboxPublisher(
    {
      confirmTimeoutMs: 1_000,
      connectionTimeoutMs: 1_000,
      rabbitmqUrl: 'amqp://local',
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
    },
    broker.connector,
  );
}

describe('RabbitMqOutboxPublisher', () => {
  it('declares the approved topology before becoming ready and maps consumer metadata', async () => {
    const broker = createFakeBroker((_channel, callback) => {
      callback(null, {});
    });
    const publisher = createPublisher(broker);

    expect(await publisher.ensureReady()).toBe(true);
    expect(broker.assertExchange).toHaveBeenNthCalledWith(
      1,
      OUTBOX_RABBITMQ_TOPOLOGY.exchange,
      'topic',
      { autoDelete: false, durable: true },
    );
    expect(broker.assertQueue).toHaveBeenCalledWith(OUTBOX_RABBITMQ_TOPOLOGY.queue, {
      arguments: {
        'x-dead-letter-exchange': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterExchange,
        'x-dead-letter-routing-key': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterRoutingKey,
        'x-queue-type': 'quorum',
      },
      autoDelete: false,
      durable: true,
      exclusive: false,
    });

    await expect(publisher.publishBatch([EVENT])).resolves.toEqual([
      { eventId: EVENT.eventId, kind: 'confirmed' },
    ]);
    expect(broker.publish).toHaveBeenCalledWith(
      OUTBOX_RABBITMQ_TOPOLOGY.exchange,
      OUTBOX_RABBITMQ_TOPOLOGY.routingKey,
      expect.any(Buffer),
      expect.objectContaining({
        appId: 'settleflow-worker',
        correlationId: EVENT.requestId,
        mandatory: true,
        messageId: EVENT.eventId,
        persistent: true,
        type: 'payment.created.v1',
      }),
      expect.any(Function),
    );
    await publisher.close();
  });

  it('treats a mandatory return as retryable even when the broker confirms', async () => {
    const broker = createFakeBroker((channel, callback) => {
      channel.emit('return', {
        properties: { messageId: EVENT.eventId },
      });
      callback(null, {});
    });
    const publisher = createPublisher(broker);

    await expect(publisher.publishBatch([EVENT])).resolves.toEqual([
      { code: 'mandatory_return', eventId: EVENT.eventId, kind: 'retry' },
    ]);
    await publisher.close();
  });

  it('keeps a broker nack retryable', async () => {
    const broker = createFakeBroker((_channel, callback) => {
      callback(new Error('synthetic nack'), {});
    });
    const publisher = createPublisher(broker);

    await expect(publisher.publishBatch([EVENT])).resolves.toEqual([
      { code: 'confirm_nack', eventId: EVENT.eventId, kind: 'retry' },
    ]);
    await publisher.close();
  });

  it('invalidates a channel after the bounded confirm timeout', async () => {
    jest.useFakeTimers();
    const broker = createFakeBroker(() => undefined);
    const publisher = createPublisher(broker);
    await publisher.ensureReady();

    const publishing = publisher.publishBatch([EVENT]);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(publishing).resolves.toEqual([
      { code: 'confirm_timeout', eventId: EVENT.eventId, kind: 'retry' },
    ]);
    expect(publisher.isReady()).toBe(false);

    await publisher.close();
    jest.useRealTimers();
  });

  it('waits for channel drain when publish reports backpressure', async () => {
    const broker = createFakeBroker((channel, callback) => {
      callback(null, {});
      setImmediate(() => channel.emit('drain'));
    }, false);
    const publisher = createPublisher(broker);

    await expect(publisher.publishBatch([EVENT])).resolves.toEqual([
      { eventId: EVENT.eventId, kind: 'confirmed' },
    ]);
    expect(publisher.isReady()).toBe(true);
    await publisher.close();
  });

  it('puts the claimed batch in flight before waiting for confirms', async () => {
    const callbacks: ConfirmCallback[] = [];
    const broker = createFakeBroker((_channel, callback) => {
      callbacks.push(callback);
    });
    const publisher = createPublisher(broker);
    await publisher.ensureReady();

    const publishing = publisher.publishBatch([EVENT, SECOND_EVENT]);
    await Promise.resolve();
    expect(broker.publish).toHaveBeenCalledTimes(2);
    for (const callback of callbacks) {
      callback(null, {});
    }

    await expect(publishing).resolves.toEqual([
      { eventId: EVENT.eventId, kind: 'confirmed' },
      { eventId: SECOND_EVENT.eventId, kind: 'confirmed' },
    ]);
    await publisher.close();
  });
});
