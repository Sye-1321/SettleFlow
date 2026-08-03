import * as amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel, Message, Options } from 'amqplib';

import { calculateFullJitterBackoff } from './outbox-retry';
import {
  PaymentCreatedEventContractError,
  serializePaymentCreatedEvent,
} from './payment-created-event.contract';
import {
  PaymentLifecycleEventContractError,
  serializePaymentLifecycleEvent,
} from './payment-lifecycle-event.contract';
import type {
  ClaimedOutboxEvent,
  OutboxPublisher,
  OutboxPublishOutcome,
  OutboxRelaySignalSink,
} from './outbox-relay.types';
import { assertOutboxRabbitMqTopology } from './rabbitmq-topology';
import {
  OperationalEventContractError,
  serializeOperationalEvent,
} from './settlement-reconciliation-event.contract';

export interface RabbitMqOutboxPublisherOptions {
  readonly confirmTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly rabbitmqUrl: string;
  readonly random?: () => number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly signal?: OutboxRelaySignalSink;
}

export type RabbitMqConnector = (
  url: string,
  options: { readonly timeout: number },
) => Promise<ChannelModel>;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('RabbitMQ operation timed out'));
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
    // A failed channel/connection is already unusable. Clearing ownership is sufficient.
  }
}

export class RabbitMqOutboxPublisher implements OutboxPublisher {
  private readonly connect: RabbitMqConnector;
  private readonly random: () => number;
  private blocked = false;
  private channel: ConfirmChannel | undefined;
  private closed = false;
  private connection: ChannelModel | undefined;
  private connectionAttempt = 0;
  private nextConnectionAttemptAt = 0;
  private ready = false;
  private readyPromise: Promise<boolean> | undefined;
  private readonly returnedEventIds = new Set<string>();

  public constructor(
    private readonly options: RabbitMqOutboxPublisherOptions,
    connector?: RabbitMqConnector,
  ) {
    this.connect =
      connector ??
      ((url, connectionOptions): Promise<ChannelModel> => amqp.connect(url, connectionOptions));
    this.random = options.random ?? Math.random;
  }

  public isReady(): boolean {
    return (
      !this.closed &&
      !this.blocked &&
      this.ready &&
      this.connection !== undefined &&
      this.channel !== undefined
    );
  }

  public async ensureReady(): Promise<boolean> {
    if (this.isReady()) {
      return true;
    }
    if (this.blocked && this.connection !== undefined && this.channel !== undefined) {
      return false;
    }
    if (this.closed || Date.now() < this.nextConnectionAttemptAt) {
      return false;
    }

    this.readyPromise ??= this.connectAndDeclare()
      .then(() => {
        this.connectionAttempt = 0;
        this.nextConnectionAttemptAt = 0;
        return this.isReady();
      })
      .catch(async () => {
        this.options.signal?.({
          code: 'declaration_or_connection_failed',
          event: 'outbox.topology.failed',
        });
        await this.disposeCurrent();
        this.connectionAttempt += 1;
        this.nextConnectionAttemptAt =
          Date.now() +
          calculateFullJitterBackoff({
            attemptCount: this.connectionAttempt,
            baseMs: this.options.retryBaseMs,
            maxMs: this.options.retryMaxMs,
            random: this.random,
          });
        return false;
      })
      .finally(() => {
        this.readyPromise = undefined;
      });

    return this.readyPromise;
  }

  public async publishBatch(
    events: readonly ClaimedOutboxEvent[],
  ): Promise<readonly OutboxPublishOutcome[]> {
    if (!(await this.ensureReady())) {
      return events.map((event) => ({
        code: 'publisher_unavailable',
        eventId: event.eventId,
        kind: 'retry',
      }));
    }

    const outcomes: Promise<OutboxPublishOutcome>[] = [];
    for (const event of events) {
      const channel = this.channel;
      if (channel === undefined || !this.isReady()) {
        outcomes.push(
          Promise.resolve({
            code: 'publisher_unavailable',
            eventId: event.eventId,
            kind: 'retry',
          }),
        );
        continue;
      }

      let serialized:
        | (ReturnType<typeof serializePaymentCreatedEvent> & {
            readonly eventType: 'payment.created.v1';
            readonly routingKey: 'payment.created.v1';
          })
        | ReturnType<typeof serializePaymentLifecycleEvent>
        | ReturnType<typeof serializeOperationalEvent>;
      try {
        serialized =
          event.eventType === 'payment.created.v1'
            ? {
                ...serializePaymentCreatedEvent(event),
                eventType: 'payment.created.v1',
                routingKey: 'payment.created.v1',
              }
            : event.eventType === 'payment.captured.v1' || event.eventType === 'payment.refunded.v1'
              ? serializePaymentLifecycleEvent(event)
              : serializeOperationalEvent(event);
      } catch (error: unknown) {
        if (
          error instanceof PaymentCreatedEventContractError ||
          error instanceof PaymentLifecycleEventContractError ||
          error instanceof OperationalEventContractError
        ) {
          outcomes.push(
            Promise.resolve({
              code: 'event_contract_invalid',
              eventId: event.eventId,
              kind: 'retry',
            }),
          );
          continue;
        }
        throw error;
      }

      const properties: Options.Publish = {
        appId: 'settleflow-worker',
        contentEncoding: 'utf-8',
        contentType: 'application/json',
        correlationId: serialized.requestId,
        headers: {
          'x-settleflow-aggregate-id':
            'paymentId' in serialized ? serialized.paymentId : serialized.aggregateId,
          'x-settleflow-aggregate-type':
            'paymentId' in serialized ? 'payment_intent' : serialized.aggregateType,
          'x-settleflow-merchant-id': serialized.merchantId,
          'x-settleflow-publish-attempt': event.attemptCount,
          'x-settleflow-schema-version': 1,
        },
        mandatory: true,
        messageId: serialized.eventId,
        persistent: true,
        timestamp: Math.floor(serialized.occurredAt.getTime() / 1_000),
        type: serialized.eventType,
      };
      const published = this.publishOne(channel, event.eventId, serialized.content, properties);
      outcomes.push(published.outcome);

      if (!published.writeAccepted && this.isReady()) {
        const drained = await this.waitForDrain(channel);
        if (!drained) {
          await this.invalidateChannel(channel);
        }
      }
    }

    return Promise.all(outcomes);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    await this.disposeCurrent();
  }

  private async connectAndDeclare(): Promise<void> {
    await this.disposeCurrent();
    this.blocked = false;
    const connection = await withTimeout(
      this.connect(this.options.rabbitmqUrl, { timeout: this.options.connectionTimeoutMs }),
      this.options.connectionTimeoutMs,
    );
    if (this.closed) {
      await closeSafely(connection);
      throw new Error('RabbitMQ publisher is closed');
    }

    this.connection = connection;
    connection.on('error', () => {
      this.ready = false;
    });
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
        this.ready = false;
      }
    });
    connection.on('blocked', () => {
      this.blocked = true;
      this.ready = false;
    });
    connection.on('unblocked', () => {
      this.blocked = false;
      if (this.connection === connection && this.channel !== undefined) {
        this.ready = true;
      }
    });

    const channel = await withTimeout(
      connection.createConfirmChannel(),
      this.options.connectionTimeoutMs,
    );
    this.channel = channel;
    channel.on('error', () => {
      this.ready = false;
    });
    channel.on('close', () => {
      if (this.channel === channel) {
        this.channel = undefined;
        this.ready = false;
      }
    });
    channel.on('return', (message: Message) => {
      const eventId: unknown = message.properties.messageId;
      if (typeof eventId === 'string') {
        this.returnedEventIds.add(eventId);
      }
    });

    await withTimeout(assertOutboxRabbitMqTopology(channel), this.options.connectionTimeoutMs);
    this.ready = !this.blocked;
    if (this.ready) {
      this.options.signal?.({ event: 'outbox.topology.ready' });
    }
  }

  private publishOne(
    channel: ConfirmChannel,
    eventId: string,
    content: Buffer,
    properties: Options.Publish,
  ): { readonly outcome: Promise<OutboxPublishOutcome>; readonly writeAccepted: boolean } {
    let settled = false;
    let resolveOutcome: (outcome: OutboxPublishOutcome) => void = () => undefined;
    const outcome = new Promise<OutboxPublishOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const finish = (result: OutboxPublishOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      this.returnedEventIds.delete(eventId);
      resolveOutcome(result);
    };

    const timeout = setTimeout(() => {
      finish({ code: 'confirm_timeout', eventId, kind: 'retry' });
      void this.invalidateChannel(channel);
    }, this.options.confirmTimeoutMs);
    timeout.unref();

    let writeAccepted: boolean;
    try {
      writeAccepted = channel.publish(
        'settleflow.domain-events',
        properties.type ?? '',
        content,
        properties,
        (error: unknown) => {
          setImmediate(() => {
            if (error !== null && error !== undefined) {
              finish({ code: 'confirm_nack', eventId, kind: 'retry' });
            } else if (this.returnedEventIds.has(eventId)) {
              finish({ code: 'mandatory_return', eventId, kind: 'retry' });
            } else {
              finish({ eventId, kind: 'confirmed' });
            }
          });
        },
      );
    } catch {
      finish({ code: 'publisher_unavailable', eventId, kind: 'retry' });
      void this.invalidateChannel(channel);
      writeAccepted = false;
    }

    return { outcome, writeAccepted };
  }

  private async waitForDrain(channel: ConfirmChannel): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        channel.off('drain', onDrain);
        channel.off('close', onClose);
        resolve(result);
      };
      const onDrain = (): void => {
        finish(true);
      };
      const onClose = (): void => {
        finish(false);
      };
      channel.once('drain', onDrain);
      channel.once('close', onClose);
      const timeout = setTimeout(() => {
        finish(false);
      }, this.options.confirmTimeoutMs);
      timeout.unref();
    });
  }

  private async invalidateChannel(channel: ConfirmChannel): Promise<void> {
    if (this.channel !== channel) {
      return;
    }
    this.ready = false;
    this.channel = undefined;
    const connection = this.connection;
    this.connection = undefined;
    await closeSafely(channel);
    await closeSafely(connection);
  }

  private async disposeCurrent(): Promise<void> {
    this.ready = false;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    this.blocked = false;
    this.returnedEventIds.clear();
    await closeSafely(channel);
    await closeSafely(connection);
  }
}
