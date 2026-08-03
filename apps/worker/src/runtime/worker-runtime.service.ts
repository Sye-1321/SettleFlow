import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  OutboxRelayService,
  RabbitMqOutboxPublisher,
  RabbitMqPaymentCreatedConsumer,
  RabbitMqSettlementLifecycleConsumer,
} from '@settleflow/eventing';
import { PrismaDatabase } from '@settleflow/infrastructure';
import { ReconciliationProcessor } from '@settleflow/reconciliation';
import { WebhookDeliveryService } from '@settleflow/webhooks';

import { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { OutboxRelaySignalService } from './outbox-relay-signal.service';
import { WebhookDeliverySignalService } from './webhook-delivery-signal.service';

@Injectable()
export class WorkerRuntimeService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly deliveryWorkerId = `webhook_${randomUUID()}`;
  private readonly outboxWorkerId = `outbox_${randomUUID()}`;
  private deliveryInFlight: Promise<number> | undefined;
  private deliveryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private postgresqlUnavailableReported = false;
  private rabbitmqPublisherUnavailableReported = false;
  private relayInFlight: Promise<number> | undefined;
  private relayTimer: NodeJS.Timeout | undefined;
  private readinessRefresh: Promise<void> | undefined;
  private reconciliationInFlight: Promise<boolean> | undefined;
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private readonly reconciliationWorkerId = `reconciliation_${randomUUID()}`;
  private stopping = false;
  private webhookDeliveryUnavailableReported = false;

  public constructor(
    private readonly config: ConfigService<WorkerEnvironment, true>,
    private readonly prisma: PrismaDatabase,
    private readonly publisher: RabbitMqOutboxPublisher,
    private readonly consumer: RabbitMqPaymentCreatedConsumer,
    private readonly settlementConsumer: RabbitMqSettlementLifecycleConsumer,
    private readonly reconciliation: ReconciliationProcessor,
    private readonly relay: OutboxRelayService,
    private readonly delivery: WebhookDeliveryService,
    private readonly health: WorkerHealthService,
    private readonly signals: OutboxRelaySignalService,
    private readonly deliverySignals: WebhookDeliverySignalService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    const heartbeatIntervalMs = this.config.get('WORKER_HEARTBEAT_INTERVAL_MS', {
      infer: true,
    });

    this.heartbeatTimer = setInterval(() => {
      void this.recordHeartbeat();
    }, heartbeatIntervalMs);

    await this.refreshReadiness();
    this.health.markRunning();
    this.signals.record({ event: 'outbox.relay.started' });
    this.deliverySignals.record({ event: 'webhook.delivery.dispatcher_started' });
    this.scheduleRelay(0);
    this.scheduleDelivery(0);
    this.scheduleReconciliation(0);
  }

  public beforeApplicationShutdown(signal?: string): void {
    this.stopping = true;
    this.consumer.beginShutdown();
    this.settlementConsumer.beginShutdown();
    this.delivery.beginShutdown();
    this.clearTimers();
    this.health.markStopping();
    this.signals.record({
      code: signal ?? 'application',
      event: 'outbox.relay.stopping',
    });
    this.deliverySignals.record({
      code: signal ?? 'application',
      event: 'webhook.delivery.dispatcher_stopping',
    });
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.clearTimers();

    const activeRelay = this.relayInFlight;
    const activeDelivery = this.deliveryInFlight;
    const activeReconciliation = this.reconciliationInFlight;
    const drainTimeoutMs = this.config.get('OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS', {
      infer: true,
    });
    const deliveryDrainTimeoutMs = this.config.get('WEBHOOK_DELIVERY_SHUTDOWN_TIMEOUT_MS', {
      infer: true,
    });
    const [
      relayDrained,
      consumerDrained,
      settlementConsumerDrained,
      deliveryDrained,
      reconciliationDrained,
    ] = await Promise.all([
      activeRelay === undefined
        ? Promise.resolve(true)
        : this.waitForOperation(activeRelay, drainTimeoutMs),
      this.consumer.close(),
      this.settlementConsumer.close(),
      activeDelivery === undefined
        ? Promise.resolve(true)
        : this.waitForOperation(activeDelivery, deliveryDrainTimeoutMs),
      activeReconciliation === undefined
        ? Promise.resolve(true)
        : this.waitForOperation(
            activeReconciliation,
            this.config.get('SETTLEMENT_CONSUMER_SHUTDOWN_TIMEOUT_MS', { infer: true }),
          ),
    ]);

    if (!deliveryDrained && activeDelivery !== undefined) {
      this.delivery.abortActive();
      await this.waitForOperation(
        activeDelivery,
        this.config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
      );
    }
    await this.publisher.close();
    if (!relayDrained && activeRelay !== undefined) {
      await this.waitForOperation(
        activeRelay,
        this.config.get('DEPENDENCY_READINESS_TIMEOUT_MS', { infer: true }),
      );
    }
    await this.prisma.close();

    this.signals.record({
      code: relayDrained ? 'drained' : 'drain_timeout',
      event: 'outbox.relay.stopped',
    });
    if (!consumerDrained) {
      this.logger.warn(JSON.stringify({ event: 'webhook.projection.consumer.drain_timeout' }));
    }
    if (!settlementConsumerDrained) {
      this.logger.warn(JSON.stringify({ event: 'settlement.consumer.drain_timeout' }));
    }
    if (!reconciliationDrained) {
      this.logger.warn(JSON.stringify({ event: 'reconciliation.processor.drain_timeout' }));
    }
    this.deliverySignals.record({
      code: deliveryDrained ? 'drained' : 'drain_timeout',
      event: 'webhook.delivery.dispatcher_stopped',
    });
  }

  private async recordHeartbeat(): Promise<void> {
    await this.refreshReadiness();
    this.logger.debug(
      JSON.stringify({
        event: 'worker.heartbeat',
        liveness: this.health.getLiveness(),
        readiness: this.health.getReadiness(),
      }),
    );
  }

  private async refreshReadiness(): Promise<void> {
    this.readinessRefresh ??= Promise.all([
      this.prisma.checkConnectivity(),
      this.publisher.ensureReady(),
      this.consumer.ensureReady(),
      this.settlementConsumer.ensureReady(),
      this.delivery.ensureReady(),
    ])
      .then(
        ([
          postgresql,
          rabbitmqPublisher,
          rabbitmqConsumer,
          settlementConsumer,
          webhookDelivery,
        ]) => {
          this.updateDependencyReadiness(
            postgresql,
            rabbitmqPublisher,
            rabbitmqConsumer && settlementConsumer,
            webhookDelivery,
          );
        },
      )
      .finally(() => {
        this.readinessRefresh = undefined;
      });

    await this.readinessRefresh;
  }

  private scheduleRelay(delayMs: number): void {
    if (this.stopping || this.relayTimer !== undefined) {
      return;
    }

    this.relayTimer = setTimeout(() => {
      this.relayTimer = undefined;
      void this.runRelayCycle();
    }, delayMs);
    this.relayTimer.unref();
  }

  private scheduleDelivery(delayMs: number): void {
    if (this.stopping || this.deliveryTimer !== undefined) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = undefined;
      void this.runDeliveryCycle();
    }, delayMs);
    this.deliveryTimer.unref();
  }

  private scheduleReconciliation(delayMs: number): void {
    if (this.stopping || this.reconciliationTimer !== undefined) return;
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined;
      void this.runReconciliationCycle();
    }, delayMs);
    this.reconciliationTimer.unref();
  }

  private async runReconciliationCycle(): Promise<void> {
    if (this.stopping || this.reconciliationInFlight !== undefined) return;
    const operation = this.reconciliation.processNext(this.reconciliationWorkerId);
    this.reconciliationInFlight = operation;
    let processed = false;
    try {
      processed = await operation;
      if (processed) this.logger.log(JSON.stringify({ event: 'reconciliation.import.completed' }));
    } catch {
      await this.refreshReadiness();
      this.logger.warn(JSON.stringify({ event: 'reconciliation.processor.cycle_failed' }));
    }
    if (this.reconciliationInFlight === operation) this.reconciliationInFlight = undefined;
    this.scheduleReconciliation(
      processed ? 0 : this.config.get('RECONCILIATION_POLL_INTERVAL_MS', { infer: true }),
    );
  }

  private async runDeliveryCycle(): Promise<void> {
    if (this.stopping || this.deliveryInFlight !== undefined) return;
    const operation = this.executeDeliveryCycle();
    this.deliveryInFlight = operation;
    const nextDelayMs = await operation;
    if (this.deliveryInFlight === operation) this.deliveryInFlight = undefined;
    this.scheduleDelivery(nextDelayMs);
  }

  private async executeDeliveryCycle(): Promise<number> {
    let nextDelayMs = this.config.get('WEBHOOK_DELIVERY_POLL_INTERVAL_MS', { infer: true });
    try {
      const batchSize = Math.min(
        this.config.get('WEBHOOK_DELIVERY_BATCH_SIZE', { infer: true }),
        this.config.get('WEBHOOK_DELIVERY_CONCURRENCY', { infer: true }),
      );
      const result = await this.delivery.runOnce(this.deliveryWorkerId, batchSize);
      this.updateDependencyReadiness(
        true,
        this.publisher.isReady(),
        this.consumer.isReady() && this.settlementConsumer.isReady(),
        result.dispatcherReady,
      );
      if (result.claimed > 0 || result.ownershipLost > 0 || result.recoveredUnknown > 0) {
        this.deliverySignals.record({
          claimed: result.claimed,
          count: result.claimed,
          deadLettered: result.deadLettered,
          delivered: result.delivered,
          event: 'webhook.delivery.dispatcher_batch',
          ownershipLost: result.ownershipLost,
          recoveredUnknown: result.recoveredUnknown,
          retrying: result.retrying,
        });
      }
      if (result.claimed === batchSize) nextDelayMs = 0;
    } catch {
      await this.refreshReadiness();
      this.deliverySignals.record({
        code: 'cycle_failed',
        event: 'webhook.delivery.dispatcher_unavailable',
      });
    }
    return nextDelayMs;
  }

  private async runRelayCycle(): Promise<void> {
    if (this.stopping || this.relayInFlight !== undefined) {
      return;
    }

    const operation = this.executeRelayCycle();
    this.relayInFlight = operation;
    const nextDelayMs = await operation;
    if (this.relayInFlight === operation) {
      this.relayInFlight = undefined;
    }
    this.scheduleRelay(nextDelayMs);
  }

  private async executeRelayCycle(): Promise<number> {
    let nextDelayMs = this.config.get('OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true });
    try {
      const result = await this.relay.runOnce(this.outboxWorkerId);
      if (result.publisherReady) {
        this.updateDependencyReadiness(
          true,
          true,
          this.consumer.isReady() && this.settlementConsumer.isReady(),
          this.delivery.isReady(),
        );
      } else {
        await this.refreshReadiness();
      }

      if (result.claimed > 0 || result.ownershipLost > 0) {
        this.logger.log(
          JSON.stringify({
            ...result,
            event: 'outbox.relay.batch',
          }),
        );
      }
      if (result.claimed === this.config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true })) {
        nextDelayMs = 0;
      }
    } catch {
      await this.refreshReadiness();
      this.logger.warn(
        JSON.stringify({
          event: 'outbox.relay.cycle_failed',
          readiness: this.health.getReadiness(),
        }),
      );
    }
    return nextDelayMs;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.relayTimer !== undefined) {
      clearTimeout(this.relayTimer);
      this.relayTimer = undefined;
    }
    if (this.deliveryTimer !== undefined) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = undefined;
    }
    if (this.reconciliationTimer !== undefined) {
      clearTimeout(this.reconciliationTimer);
      this.reconciliationTimer = undefined;
    }
  }

  private updateDependencyReadiness(
    postgresql: boolean,
    rabbitmqPublisher: boolean,
    rabbitmqConsumer: boolean,
    webhookDelivery: boolean,
  ): void {
    if (!postgresql && !this.postgresqlUnavailableReported) {
      this.signals.record({
        code: 'postgresql_unavailable',
        event: 'outbox.relay.dependency_unavailable',
      });
    }
    if (!rabbitmqPublisher && !this.rabbitmqPublisherUnavailableReported) {
      this.signals.record({
        code: 'rabbitmq_publisher_unavailable',
        event: 'outbox.relay.dependency_unavailable',
      });
    }
    this.postgresqlUnavailableReported = !postgresql;
    this.rabbitmqPublisherUnavailableReported = !rabbitmqPublisher;
    if (!webhookDelivery && !this.webhookDeliveryUnavailableReported) {
      this.deliverySignals.record({
        code: 'dispatcher_dependency_unavailable',
        event: 'webhook.delivery.dispatcher_unavailable',
      });
    }
    this.webhookDeliveryUnavailableReported = !webhookDelivery;
    this.health.updateDependencies({
      postgresql: { status: postgresql ? 'up' : 'down' },
      rabbitmqConsumer: { status: rabbitmqConsumer ? 'up' : 'down' },
      rabbitmqPublisher: { status: rabbitmqPublisher ? 'up' : 'down' },
      reconciliationProcessor: { status: postgresql && !this.stopping ? 'up' : 'down' },
      webhookDelivery: { status: webhookDelivery ? 'up' : 'down' },
    });
  }

  private async waitForOperation(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      timeout.unref();
    });

    return Promise.race([operation.then(() => true), timedOut]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
  }
}
