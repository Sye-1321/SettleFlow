import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

import { DatabaseUnavailableError, isDatabaseUnavailableError } from '@settleflow/infrastructure';

import { calculateFullJitterBackoff } from './outbox-retry';
import {
  PaymentLifecycleMessageContractError,
  validatePaymentLifecycleMessage,
} from './payment-lifecycle-event.contract';
import type { ValidatedPaymentEventMessage } from './payment-created-event.contract';
import { assertOutboxRabbitMqTopology, SETTLEMENT_LIFECYCLE_ROUTE } from './rabbitmq-topology';

export interface SettlementLifecycleMessageHandler {
  handle(message: ValidatedPaymentEventMessage): Promise<unknown>;
}

export interface SettlementLifecycleConsumerSignal {
  readonly code?: string;
  readonly event: string;
  readonly eventId?: string;
  readonly eventType?: 'payment.captured.v1' | 'payment.refunded.v1';
}

export interface RabbitMqSettlementLifecycleConsumerOptions {
  readonly bodyLimitBytes: number;
  readonly connectionTimeoutMs: number;
  readonly prefetch: number;
  readonly rabbitmqUrl: string;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly shutdownTimeoutMs: number;
  readonly signal?: (signal: SettlementLifecycleConsumerSignal) => void;
}

export class RabbitMqSettlementLifecycleConsumer {
  private channel: Channel | undefined;
  private connection: ChannelModel | undefined;
  private consumerTag: string | undefined;
  private closed = false;
  private stopping = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readyPromise: Promise<boolean> | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  public constructor(
    private readonly handler: SettlementLifecycleMessageHandler,
    private readonly options: RabbitMqSettlementLifecycleConsumerOptions,
  ) {}

  public isReady(): boolean {
    return (
      !this.closed && !this.stopping && this.channel !== undefined && this.consumerTag !== undefined
    );
  }

  public async ensureReady(): Promise<boolean> {
    if (this.isReady()) return true;
    if (this.closed || this.stopping) return false;
    this.readyPromise ??= this.connect()
      .catch(async () => {
        await this.dispose();
        this.scheduleReconnect();
        return false;
      })
      .finally(() => {
        this.readyPromise = undefined;
      });
    return this.readyPromise;
  }

  public beginShutdown(): void {
    this.stopping = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
  }

  public async close(): Promise<boolean> {
    this.beginShutdown();
    this.closed = true;
    if (this.channel !== undefined && this.consumerTag !== undefined) {
      try {
        await this.channel.cancel(this.consumerTag);
      } catch {
        // The channel may already be closed by a concurrent broker failure.
      }
    }
    const drained = await this.drain();
    await this.dispose();
    return drained;
  }

  private async connect(): Promise<boolean> {
    await this.dispose();
    const connection = await amqp.connect(this.options.rabbitmqUrl, {
      timeout: this.options.connectionTimeoutMs,
    });
    this.connection = connection;
    connection.on('error', () => undefined);
    connection.on('close', () => {
      if (this.connection === connection) {
        void this.dispose().then(() => this.scheduleReconnect());
      }
    });
    const channel = await connection.createChannel();
    this.channel = channel;
    channel.on('error', () => undefined);
    channel.on('close', () => {
      if (this.channel === channel) {
        this.channel = undefined;
        this.consumerTag = undefined;
        this.scheduleReconnect();
      }
    });
    await assertOutboxRabbitMqTopology(channel);
    await channel.prefetch(this.options.prefetch);
    const reply = await channel.consume(
      SETTLEMENT_LIFECYCLE_ROUTE.queue,
      (raw) => {
        if (raw === null) {
          void this.dispose().then(() => this.scheduleReconnect());
          return;
        }
        const operation = this.process(channel, raw);
        this.inFlight.add(operation);
        void operation.finally(() => this.inFlight.delete(operation));
      },
      { noAck: false },
    );
    this.consumerTag = reply.consumerTag;
    this.attempt = 0;
    this.options.signal?.({ event: 'settlement.consumer.ready' });
    return true;
  }

  private async process(channel: Channel, raw: ConsumeMessage): Promise<void> {
    let message: ValidatedPaymentEventMessage;
    try {
      message = validatePaymentLifecycleMessage(raw, this.options.bodyLimitBytes);
    } catch (error: unknown) {
      if (error instanceof PaymentLifecycleMessageContractError && this.channel === channel) {
        this.options.signal?.({ code: 'contract_invalid', event: 'settlement.consumer.rejected' });
        channel.nack(raw, false, false);
        return;
      }
      await this.dispose();
      this.scheduleReconnect();
      return;
    }
    try {
      await this.handler.handle(message);
      if (this.channel === channel) {
        channel.ack(raw);
        this.options.signal?.({
          event: 'settlement.consumer.processed',
          eventId: message.event.eventId,
          eventType: message.event.eventType,
        });
      }
    } catch (error: unknown) {
      if (error instanceof DatabaseUnavailableError || isDatabaseUnavailableError(error)) {
        this.options.signal?.({
          code: 'postgresql_unavailable',
          event: 'settlement.consumer.dependency_unavailable',
        });
        await this.dispose();
        this.scheduleReconnect();
        return;
      }
      this.options.signal?.({ code: 'processing_failed', event: 'settlement.consumer.retrying' });
      await this.dispose();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.stopping || this.reconnectTimer !== undefined) return;
    this.attempt += 1;
    const delay = calculateFullJitterBackoff({
      attemptCount: this.attempt,
      baseMs: this.options.reconnectBaseMs,
      maxMs: this.options.reconnectMaxMs,
      random: Math.random,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureReady();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async drain(): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs);
      timer.unref();
    });
    return Promise.race([Promise.allSettled([...this.inFlight]).then(() => true), timeout]).finally(
      () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    );
  }

  private async dispose(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    this.consumerTag = undefined;
    try {
      await channel?.close();
    } catch {
      // Closing an already-closed channel is safe during reconnect/shutdown.
    }
    try {
      await connection?.close();
    } catch {
      // Closing an already-closed connection is safe during reconnect/shutdown.
    }
  }
}
