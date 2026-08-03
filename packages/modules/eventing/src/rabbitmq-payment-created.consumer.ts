import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

import { DatabaseUnavailableError, isDatabaseUnavailableError } from '@settleflow/infrastructure';

import { PermanentMessageProcessingError } from './eventing.errors';
import { calculateFullJitterBackoff } from './outbox-retry';
import {
  PaymentCreatedMessageContractError,
  validatePaymentEventMessage,
} from './payment-created-event.contract';
import { PaymentLifecycleMessageContractError } from './payment-lifecycle-event.contract';
import { assertOutboxRabbitMqTopology, PAYMENT_EVENT_ROUTES } from './rabbitmq-topology';
import type { ValidatedDomainEventMessage } from './inbox.types';
import {
  OperationalEventContractError,
  validateOperationalEventMessage,
} from './settlement-reconciliation-event.contract';

export interface PaymentCreatedMessageHandler {
  handle(message: ValidatedDomainEventMessage): Promise<{
    readonly kind: 'duplicate' | 'processed';
    readonly value?: { readonly alreadyProjected: boolean; readonly deliveryCount: number };
  }>;
}

export interface WebhookProjectionConsumerSignal {
  readonly code?: string;
  readonly deliveryCount?: number;
  readonly durationMs?: number;
  readonly event:
    | 'webhook.projection.consumer.ready'
    | 'webhook.projection.consumer.reconnect_scheduled'
    | 'webhook.projection.consumer.stopped'
    | 'webhook.projection.consumer.stopping'
    | 'webhook.projection.consumer.unavailable'
    | 'webhook.projection.message.dead_lettered'
    | 'webhook.projection.message.duplicate'
    | 'webhook.projection.message.processed'
    | 'webhook.projection.message.received';
  readonly eventId?: string;
  readonly merchantId?: string;
  readonly redelivered?: boolean;
  readonly requestId?: string;
}

export type WebhookProjectionConsumerSignalSink = (signal: WebhookProjectionConsumerSignal) => void;

export interface RabbitMqPaymentCreatedConsumerOptions {
  readonly bodyLimitBytes: number;
  readonly connectionTimeoutMs: number;
  readonly prefetch: number;
  readonly rabbitmqUrl: string;
  readonly random?: () => number;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly shutdownTimeoutMs: number;
  readonly signal?: WebhookProjectionConsumerSignalSink;
}

export type RabbitMqConsumerConnector = (
  url: string,
  options: { readonly timeout: number },
) => Promise<ChannelModel>;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('RabbitMQ consumer operation timed out'));
    }, timeoutMs);
    timeout.unref();
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

async function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> {
  if (resource === undefined) {
    return;
  }
  try {
    await resource.close();
  } catch {
    // Failed channels/connections are already unusable and unacked messages requeue.
  }
}

export class RabbitMqPaymentCreatedConsumer {
  private readonly connect: RabbitMqConsumerConnector;
  private readonly random: () => number;
  private channel: Channel | undefined;
  private closed = false;
  private connection: ChannelModel | undefined;
  private connectionAttempt = 0;
  private consumerTags: string[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private ready = false;
  private readyPromise: Promise<boolean> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopping = false;

  public constructor(
    private readonly handler: PaymentCreatedMessageHandler,
    private readonly options: RabbitMqPaymentCreatedConsumerOptions,
    connector?: RabbitMqConsumerConnector,
  ) {
    this.connect =
      connector ??
      ((url, connectionOptions): Promise<ChannelModel> => amqp.connect(url, connectionOptions));
    this.random = options.random ?? Math.random;
  }

  public isReady(): boolean {
    return (
      !this.closed &&
      !this.stopping &&
      this.ready &&
      this.connection !== undefined &&
      this.channel !== undefined &&
      this.consumerTags.length === Object.keys(PAYMENT_EVENT_ROUTES).length
    );
  }

  public async ensureReady(): Promise<boolean> {
    if (this.isReady()) {
      return true;
    }
    if (this.closed || this.stopping) {
      return false;
    }
    this.readyPromise ??= this.connectAndConsume()
      .then(() => {
        this.connectionAttempt = 0;
        return this.isReady();
      })
      .catch(async () => {
        this.options.signal?.({
          code: 'connection_or_declaration_failed',
          event: 'webhook.projection.consumer.unavailable',
        });
        await this.disposeCurrent();
        this.scheduleReconnect();
        return false;
      })
      .finally(() => {
        this.readyPromise = undefined;
      });
    return this.readyPromise;
  }

  public beginShutdown(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.ready = false;
    this.clearReconnectTimer();
    this.options.signal?.({ event: 'webhook.projection.consumer.stopping' });
  }

  public async close(): Promise<boolean> {
    this.beginShutdown();
    this.closed = true;
    const channel = this.channel;
    const consumerTags = this.consumerTags;
    this.consumerTags = [];
    if (channel !== undefined) {
      for (const consumerTag of consumerTags) {
        try {
          await channel.cancel(consumerTag);
        } catch {
          // Closing the channel below also stops delivery and requeues unacked messages.
        }
      }
    }

    const drained = await this.waitForInFlight(this.options.shutdownTimeoutMs);
    await this.disposeCurrent();
    this.options.signal?.({
      code: drained ? 'drained' : 'drain_timeout',
      event: 'webhook.projection.consumer.stopped',
    });
    return drained;
  }

  public async waitForInFlight(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) {
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
    });
    return Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      timedOut,
    ]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
  }

  private async connectAndConsume(): Promise<void> {
    await this.disposeCurrent();
    const connection = await withTimeout(
      this.connect(this.options.rabbitmqUrl, { timeout: this.options.connectionTimeoutMs }),
      this.options.connectionTimeoutMs,
    );
    if (this.closed || this.stopping) {
      await closeSafely(connection);
      throw new Error('RabbitMQ consumer is stopping');
    }
    this.connection = connection;
    connection.on('error', () => {
      this.ready = false;
    });
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
        this.consumerTags = [];
        this.ready = false;
        this.options.signal?.({
          code: 'connection_closed',
          event: 'webhook.projection.consumer.unavailable',
        });
        this.scheduleReconnect();
      }
    });

    const channel = await withTimeout(connection.createChannel(), this.options.connectionTimeoutMs);
    this.channel = channel;
    channel.on('error', () => {
      this.ready = false;
    });
    channel.on('close', () => {
      if (this.channel === channel) {
        this.channel = undefined;
        this.consumerTags = [];
        this.ready = false;
        this.options.signal?.({
          code: 'channel_closed',
          event: 'webhook.projection.consumer.unavailable',
        });
        this.scheduleReconnect();
      }
    });

    await withTimeout(assertOutboxRabbitMqTopology(channel), this.options.connectionTimeoutMs);
    await channel.prefetch(this.options.prefetch);
    for (const route of Object.values(PAYMENT_EVENT_ROUTES)) {
      const reply = await channel.consume(
        route.queue,
        (message) => {
          if (message === null) {
            void this.invalidateChannel(channel, 'consumer_cancelled');
            return;
          }
          const operation = this.processMessage(channel, message);
          this.inFlight.add(operation);
          void operation.finally(() => {
            this.inFlight.delete(operation);
          });
        },
        { noAck: false },
      );
      this.consumerTags.push(reply.consumerTag);
    }
    this.ready = true;
    this.options.signal?.({ event: 'webhook.projection.consumer.ready' });
  }

  private async processMessage(channel: Channel, raw: ConsumeMessage): Promise<void> {
    const startedAt = performance.now();
    let message: ValidatedDomainEventMessage;
    try {
      message =
        raw.properties.type === 'settlement.finalized.v1' ||
        raw.properties.type === 'reconciliation.completed.v1'
          ? validateOperationalEventMessage(raw, this.options.bodyLimitBytes)
          : validatePaymentEventMessage(raw, this.options.bodyLimitBytes);
    } catch (error: unknown) {
      if (
        error instanceof PaymentCreatedMessageContractError ||
        error instanceof PaymentLifecycleMessageContractError ||
        error instanceof OperationalEventContractError
      ) {
        this.rejectIfOwned(
          channel,
          raw,
          error instanceof OperationalEventContractError ? 'operational_event_invalid' : error.code,
        );
        return;
      }
      await this.invalidateChannel(channel, 'validation_failed');
      return;
    }

    this.options.signal?.({
      event: 'webhook.projection.message.received',
      eventId: message.event.eventId,
      merchantId: message.event.merchantId,
      redelivered: message.redelivered,
      requestId: message.event.requestId,
    });
    try {
      const result = await this.handler.handle(message);
      if (this.channel === channel) {
        channel.ack(raw);
      }
      if (result.kind === 'duplicate') {
        this.options.signal?.({
          durationMs: performance.now() - startedAt,
          event: 'webhook.projection.message.duplicate',
          eventId: message.event.eventId,
          merchantId: message.event.merchantId,
          requestId: message.event.requestId,
        });
      } else {
        this.options.signal?.({
          deliveryCount: result.value?.deliveryCount ?? 0,
          durationMs: performance.now() - startedAt,
          event: 'webhook.projection.message.processed',
          eventId: message.event.eventId,
          merchantId: message.event.merchantId,
          requestId: message.event.requestId,
        });
      }
    } catch (error: unknown) {
      if (error instanceof PermanentMessageProcessingError) {
        this.rejectIfOwned(channel, raw, error.code, message);
        return;
      }
      if (error instanceof DatabaseUnavailableError || isDatabaseUnavailableError(error)) {
        await this.invalidateChannel(channel, 'postgresql_unavailable');
        return;
      }
      await this.invalidateChannel(channel, 'processing_failed');
    }
  }

  private rejectIfOwned(
    channel: Channel,
    raw: ConsumeMessage,
    code: string,
    message?: ValidatedDomainEventMessage,
  ): void {
    if (this.channel !== channel) {
      return;
    }
    try {
      channel.nack(raw, false, false);
      this.options.signal?.({
        code,
        event: 'webhook.projection.message.dead_lettered',
        ...(message === undefined
          ? {}
          : {
              eventId: message.event.eventId,
              merchantId: message.event.merchantId,
              requestId: message.event.requestId,
            }),
      });
    } catch {
      void this.invalidateChannel(channel, 'dead_letter_reject_failed');
    }
  }

  private async invalidateChannel(channel: Channel, code: string): Promise<void> {
    if (this.channel !== channel) {
      return;
    }
    this.options.signal?.({ code, event: 'webhook.projection.consumer.unavailable' });
    await this.disposeCurrent();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.stopping || this.reconnectTimer !== undefined) {
      return;
    }
    this.connectionAttempt += 1;
    const delayMs = calculateFullJitterBackoff({
      attemptCount: this.connectionAttempt,
      baseMs: this.options.reconnectBaseMs,
      maxMs: this.options.reconnectMaxMs,
      random: this.random,
    });
    this.options.signal?.({
      code: 'connection_retry',
      durationMs: delayMs,
      event: 'webhook.projection.consumer.reconnect_scheduled',
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureReady();
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async disposeCurrent(): Promise<void> {
    this.ready = false;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    this.consumerTags = [];
    await closeSafely(channel);
    await closeSafely(connection);
  }
}
