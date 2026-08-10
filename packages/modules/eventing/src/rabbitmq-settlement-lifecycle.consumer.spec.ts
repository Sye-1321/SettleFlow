import { EventEmitter } from 'node:events';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { DatabaseUnavailableError } from '@settleflow/infrastructure';

import {
  RabbitMqSettlementLifecycleConsumer,
  type SettlementLifecycleConsumerSignal,
  type SettlementLifecycleMessageHandler,
} from './rabbitmq-settlement-lifecycle.consumer';
import { OUTBOX_RABBITMQ_TOPOLOGY, SETTLEMENT_LIFECYCLE_ROUTE } from './rabbitmq-topology';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

type HandleMock = jest.MockedFunction<SettlementLifecycleMessageHandler['handle']>;

interface ConsumerHarness {
  readonly ack: jest.MockedFunction<Channel['ack']>;
  readonly cancel: jest.MockedFunction<Channel['cancel']>;
  readonly channel: Channel;
  readonly channelClose: jest.MockedFunction<Channel['close']>;
  readonly connection: ChannelModel;
  readonly connectionClose: jest.MockedFunction<ChannelModel['close']>;
  readonly consumer: RabbitMqSettlementLifecycleConsumer;
  readonly deliver: (raw: ConsumeMessage | null) => void;
  readonly handle: HandleMock;
  readonly nack: jest.MockedFunction<Channel['nack']>;
  readonly signals: jest.MockedFunction<(signal: SettlementLifecycleConsumerSignal) => void>;
}

describe('RabbitMqSettlementLifecycleConsumer', () => {
  const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const paymentId = 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const merchantId = '11111111-1111-4111-8111-111111111111';

  function message(overrides: Readonly<Record<string, unknown>> = {}): ConsumeMessage {
    const occurredAt = '2026-08-02T10:20:12.345Z';
    return {
      content: Buffer.from(
        JSON.stringify({
          availableOn: occurredAt,
          capturedAmountMinor: 1_000,
          currency: 'ETB',
          eventId,
          eventType: 'payment.captured.v1',
          merchantId,
          occurredAt,
          paymentId,
          requestId: 'req_lifecycle_contract',
          ledgerTransactionId: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        }),
      ),
      fields: {
        consumerTag: 'tag',
        deliveryTag: 1,
        exchange: OUTBOX_RABBITMQ_TOPOLOGY.exchange,
        redelivered: false,
        routingKey: SETTLEMENT_LIFECYCLE_ROUTE.routingKeys[0],
      },
      properties: {
        appId: 'settleflow-worker',
        contentEncoding: 'utf-8',
        contentType: 'application/json',
        correlationId: 'req_lifecycle_contract',
        deliveryMode: 2,
        headers: {
          'x-settleflow-aggregate-id': paymentId,
          'x-settleflow-aggregate-type': 'payment_intent',
          'x-settleflow-merchant-id': merchantId,
          'x-settleflow-publish-attempt': 1,
          'x-settleflow-schema-version': 1,
        },
        messageId: eventId,
        timestamp: Math.floor(new Date(occurredAt).getTime() / 1_000),
        type: 'payment.captured.v1',
        ...overrides,
      },
    } as unknown as ConsumeMessage;
  }

  function harness(handle?: HandleMock): ConsumerHarness {
    const channelEvents = new EventEmitter();
    const connectionEvents = new EventEmitter();
    let deliver: ((raw: ConsumeMessage | null) => void) | undefined;
    const ack: jest.MockedFunction<Channel['ack']> = jest.fn();
    const cancel: jest.MockedFunction<Channel['cancel']> = jest.fn().mockResolvedValue(undefined);
    const channelClose: jest.MockedFunction<Channel['close']> = jest
      .fn()
      .mockResolvedValue(undefined);
    const connectionClose: jest.MockedFunction<ChannelModel['close']> = jest
      .fn()
      .mockResolvedValue(undefined);
    const nack: jest.MockedFunction<Channel['nack']> = jest.fn();
    const channel = Object.assign(channelEvents, {
      ack,
      assertExchange: jest.fn().mockResolvedValue({}),
      assertQueue: jest.fn().mockResolvedValue({}),
      bindQueue: jest.fn().mockResolvedValue({}),
      cancel,
      close: channelClose,
      consume: jest.fn().mockImplementation(
        (
          _queue: string,
          consumer: (raw: ConsumeMessage | null) => void,
        ): Promise<{
          consumerTag: string;
        }> => {
          deliver = consumer;
          return Promise.resolve({ consumerTag: 'tag' });
        },
      ),
      nack,
      prefetch: jest.fn().mockResolvedValue(undefined),
    }) as unknown as Channel;
    const connection = Object.assign(connectionEvents, {
      close: connectionClose,
      createChannel: jest.fn().mockResolvedValue(channel),
    }) as unknown as ChannelModel;
    jest.mocked(amqp.connect).mockResolvedValue(connection);
    const resolvedHandle: HandleMock = handle ?? jest.fn();
    if (handle === undefined) resolvedHandle.mockResolvedValue(undefined);
    const signals: ConsumerHarness['signals'] = jest.fn();
    const consumer = new RabbitMqSettlementLifecycleConsumer(
      { handle: resolvedHandle },
      {
        bodyLimitBytes: 16_384,
        connectionTimeoutMs: 1_000,
        prefetch: 2,
        rabbitmqUrl: 'amqp://local',
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 60_000,
        shutdownTimeoutMs: 50,
        signal: signals,
      },
    );
    return {
      ack,
      cancel,
      channel,
      channelClose,
      connection,
      connectionClose,
      consumer,
      deliver: (raw: ConsumeMessage | null): void => {
        if (deliver === undefined) throw new Error('not registered');
        deliver(raw);
      },
      handle: resolvedHandle,
      nack,
      signals,
    };
  }

  afterEach(() => jest.clearAllMocks());

  it('becomes ready, processes durably, acknowledges, and drains shutdown', async () => {
    const h = harness();
    await expect(h.consumer.ensureReady()).resolves.toBe(true);
    await expect(h.consumer.ensureReady()).resolves.toBe(true);
    expect(h.consumer.isReady()).toBe(true);
    h.deliver(message());
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.signals).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'settlement.consumer.processed', eventId }),
    );
    await expect(h.consumer.close()).resolves.toBe(true);
  });

  it('dead-letters invalid contracts without invoking the handler', async () => {
    const h = harness();
    await h.consumer.ensureReady();
    const invalid = message({ type: 'payment.created.v1' });
    h.deliver(invalid);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.nack).toHaveBeenCalledWith(invalid, false, false);
    expect(h.handle).not.toHaveBeenCalled();
    await h.consumer.close();
  });

  it('leaves dependency and processing failures unacknowledged for reconnect', async () => {
    for (const error of [new DatabaseUnavailableError(), new Error('projection failed')]) {
      const handle: HandleMock = jest.fn();
      handle.mockRejectedValue(error);
      const h = harness(handle);
      await h.consumer.ensureReady();
      h.deliver(message());
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.ack).not.toHaveBeenCalled();
      expect(h.nack).not.toHaveBeenCalled();
      expect(h.consumer.isReady()).toBe(false);
      await h.consumer.close();
    }
  });

  it('fails readiness safely when connection setup fails or shutdown begins', async () => {
    const h = harness();
    jest.mocked(amqp.connect).mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(h.consumer.ensureReady()).resolves.toBe(false);
    h.consumer.beginShutdown();
    await expect(h.consumer.ensureReady()).resolves.toBe(false);
    await expect(h.consumer.close()).resolves.toBe(true);
  });

  it('reconnects when RabbitMQ cancels the consumer or closes either resource', async () => {
    for (const closeResource of ['cancel', 'channel', 'connection'] as const) {
      const h = harness();
      await h.consumer.ensureReady();
      if (closeResource === 'cancel') h.deliver(null);
      else if (closeResource === 'channel') (h.channel as unknown as EventEmitter).emit('close');
      else (h.connection as unknown as EventEmitter).emit('close');
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.consumer.isReady()).toBe(false);
      await h.consumer.close();
    }
  });

  it('returns a failed shutdown drain rather than acknowledging unfinished processing', async () => {
    const handle: HandleMock = jest.fn();
    handle.mockImplementation((): Promise<unknown> => new Promise(() => undefined));
    const h = harness(handle);
    await h.consumer.ensureReady();
    h.deliver(message());
    await new Promise((resolve) => setImmediate(resolve));
    await expect(h.consumer.close()).resolves.toBe(false);
    expect(h.ack).not.toHaveBeenCalled();
  });

  it('tolerates cancellation and resource-close races during shutdown', async () => {
    const h = harness();
    await h.consumer.ensureReady();
    h.cancel.mockRejectedValueOnce(new Error('already cancelled'));
    h.channelClose.mockRejectedValueOnce(new Error('already closed'));
    h.connectionClose.mockRejectedValueOnce(new Error('already closed'));
    await expect(h.consumer.close()).resolves.toBe(true);
  });
});
