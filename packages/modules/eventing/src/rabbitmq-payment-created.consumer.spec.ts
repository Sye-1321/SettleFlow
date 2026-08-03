import { EventEmitter } from 'node:events';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { DatabaseUnavailableError } from '@settleflow/infrastructure';

import {
  RabbitMqPaymentCreatedConsumer,
  type PaymentCreatedMessageHandler,
  type RabbitMqConsumerConnector,
} from './rabbitmq-payment-created.consumer';
import { OUTBOX_RABBITMQ_TOPOLOGY, PAYMENT_EVENT_ROUTES } from './rabbitmq-topology';

const EVENT_ID = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PAYMENT_ID = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = '2026-08-02T10:20:12.345Z';

function createMessage(properties: Readonly<Record<string, unknown>> = {}): ConsumeMessage {
  const content = Buffer.from(
    JSON.stringify({
      amountMinor: 5_000,
      currency: 'USD',
      eventId: EVENT_ID,
      eventType: 'payment.created.v1',
      merchantId: MERCHANT_ID,
      occurredAt: OCCURRED_AT,
      paymentId: PAYMENT_ID,
      requestId: 'req_consumer_test',
      status: 'CREATED',
    }),
  );
  return {
    content,
    fields: {
      consumerTag: 'consumer-tag',
      deliveryTag: 1,
      exchange: OUTBOX_RABBITMQ_TOPOLOGY.exchange,
      redelivered: false,
      routingKey: OUTBOX_RABBITMQ_TOPOLOGY.routingKey,
    },
    properties: {
      appId: 'settleflow-worker',
      contentEncoding: 'utf-8',
      contentType: 'application/json',
      correlationId: 'req_consumer_test',
      deliveryMode: 2,
      headers: {
        'x-settleflow-aggregate-id': PAYMENT_ID,
        'x-settleflow-aggregate-type': 'payment_intent',
        'x-settleflow-merchant-id': MERCHANT_ID,
        'x-settleflow-publish-attempt': 1,
        'x-settleflow-schema-version': 1,
      },
      messageId: EVENT_ID,
      timestamp: Math.floor(new Date(OCCURRED_AT).getTime() / 1_000),
      type: 'payment.created.v1',
      ...properties,
    },
  } as unknown as ConsumeMessage;
}

interface FakeRabbitMq {
  readonly ack: jest.Mock;
  readonly cancel: jest.Mock;
  readonly channelClose: jest.Mock;
  readonly connectionClose: jest.Mock;
  readonly consume: jest.Mock;
  readonly connector: RabbitMqConsumerConnector;
  readonly deliver: (message: ConsumeMessage | null) => void;
  readonly nack: jest.Mock;
  readonly prefetch: jest.Mock;
}

function createFakeRabbitMq(): FakeRabbitMq {
  const channelEvents = new EventEmitter();
  const connectionEvents = new EventEmitter();
  const ack = jest.fn();
  const nack = jest.fn();
  const cancel = jest.fn().mockResolvedValue(undefined);
  const channelClose = jest.fn().mockResolvedValue(undefined);
  const connectionClose = jest.fn().mockResolvedValue(undefined);
  const prefetch = jest.fn().mockResolvedValue(undefined);
  let deliveryHandler: ((message: ConsumeMessage | null) => void) | undefined;
  const consume = jest.fn((_queue: string, handler: (message: ConsumeMessage | null) => void) => {
    deliveryHandler = handler;
    return Promise.resolve({ consumerTag: 'consumer-tag' });
  });
  const channel = Object.assign(channelEvents, {
    ack,
    assertExchange: jest.fn().mockResolvedValue({ exchange: '' }),
    assertQueue: jest.fn().mockResolvedValue({ consumerCount: 0, messageCount: 0, queue: '' }),
    bindQueue: jest.fn().mockResolvedValue({}),
    cancel,
    close: channelClose,
    consume,
    nack,
    prefetch,
  }) as unknown as Channel;
  const connection = Object.assign(connectionEvents, {
    close: connectionClose,
    createChannel: jest.fn().mockResolvedValue(channel),
  }) as unknown as ChannelModel;
  return {
    ack,
    cancel,
    channelClose,
    connectionClose,
    consume,
    connector: jest.fn().mockResolvedValue(connection) as RabbitMqConsumerConnector,
    deliver: (message: ConsumeMessage | null): void => {
      if (deliveryHandler === undefined) {
        throw new Error('Consumer callback is not registered');
      }
      deliveryHandler(message);
    },
    nack,
    prefetch,
  };
}

function createConsumer(
  broker: FakeRabbitMq,
  handler: PaymentCreatedMessageHandler,
): RabbitMqPaymentCreatedConsumer {
  return new RabbitMqPaymentCreatedConsumer(
    handler,
    {
      bodyLimitBytes: 16_384,
      connectionTimeoutMs: 1_000,
      prefetch: 2,
      rabbitmqUrl: 'amqp://local',
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 60_000,
      shutdownTimeoutMs: 10_000,
    },
    broker.connector,
  );
}

describe('RabbitMqPaymentCreatedConsumer', () => {
  it('becomes ready only after registering a manual-ack consumer and acks after durable success', async () => {
    const broker = createFakeRabbitMq();
    const handler = {
      handle: jest.fn().mockResolvedValue({
        kind: 'processed',
        value: { alreadyProjected: false, deliveryCount: 1 },
      }),
    };
    const consumer = createConsumer(broker, handler);

    await expect(consumer.ensureReady()).resolves.toBe(true);
    expect(consumer.isReady()).toBe(true);
    expect(broker.prefetch).toHaveBeenCalledWith(2);
    expect(broker.consume).toHaveBeenCalledTimes(Object.keys(PAYMENT_EVENT_ROUTES).length);
    for (const route of Object.values(PAYMENT_EVENT_ROUTES)) {
      expect(broker.consume).toHaveBeenCalledWith(route.queue, expect.any(Function), {
        noAck: false,
      });
    }

    broker.deliver(createMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(broker.ack).toHaveBeenCalledTimes(1);
    expect(broker.nack).not.toHaveBeenCalled();
    await expect(consumer.close()).resolves.toBe(true);
    expect(broker.cancel).toHaveBeenCalledWith('consumer-tag');
    expect(broker.channelClose).toHaveBeenCalledTimes(1);
    expect(broker.connectionClose).toHaveBeenCalledTimes(1);
  });

  it('dead-letters invalid messages immediately without invoking the handler', async () => {
    const broker = createFakeRabbitMq();
    const handle = jest.fn();
    const handler = { handle } as PaymentCreatedMessageHandler;
    const consumer = createConsumer(broker, handler);
    await consumer.ensureReady();

    const invalid = createMessage({ type: 'payment.updated.v1' });
    broker.deliver(invalid);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handle).not.toHaveBeenCalled();
    expect(broker.nack).toHaveBeenCalledWith(invalid, false, false);
    expect(broker.ack).not.toHaveBeenCalled();
    await consumer.close();
  });

  it('leaves a message unacknowledged and reconnects when PostgreSQL is unavailable', async () => {
    const broker = createFakeRabbitMq();
    const handler = {
      handle: jest.fn().mockRejectedValue(new DatabaseUnavailableError()),
    } as PaymentCreatedMessageHandler;
    const consumer = createConsumer(broker, handler);
    await consumer.ensureReady();

    broker.deliver(createMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(broker.ack).not.toHaveBeenCalled();
    expect(broker.nack).not.toHaveBeenCalled();
    expect(broker.channelClose).toHaveBeenCalledTimes(1);
    expect(broker.connectionClose).toHaveBeenCalledTimes(1);
    expect(consumer.isReady()).toBe(false);
    await consumer.close();
  });
});
