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
} from '@settleflow/eventing';
import { PrismaDatabase } from '@settleflow/infrastructure';

import { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { OutboxRelaySignalService } from './outbox-relay-signal.service';

@Injectable()
export class WorkerRuntimeService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly workerId = `outbox_${randomUUID()}`;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private postgresqlUnavailableReported = false;
  private rabbitmqPublisherUnavailableReported = false;
  private relayInFlight: Promise<number> | undefined;
  private relayTimer: NodeJS.Timeout | undefined;
  private readinessRefresh: Promise<void> | undefined;
  private stopping = false;

  public constructor(
    private readonly config: ConfigService<WorkerEnvironment, true>,
    private readonly prisma: PrismaDatabase,
    private readonly publisher: RabbitMqOutboxPublisher,
    private readonly consumer: RabbitMqPaymentCreatedConsumer,
    private readonly relay: OutboxRelayService,
    private readonly health: WorkerHealthService,
    private readonly signals: OutboxRelaySignalService,
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
    this.scheduleRelay(0);
  }

  public beforeApplicationShutdown(signal?: string): void {
    this.stopping = true;
    this.consumer.beginShutdown();
    this.clearTimers();
    this.health.markStopping();
    this.signals.record({
      code: signal ?? 'application',
      event: 'outbox.relay.stopping',
    });
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.clearTimers();

    const activeRelay = this.relayInFlight;
    const drainTimeoutMs = this.config.get('OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS', {
      infer: true,
    });
    const [relayDrained, consumerDrained] = await Promise.all([
      activeRelay === undefined
        ? Promise.resolve(true)
        : this.waitForRelay(activeRelay, drainTimeoutMs),
      this.consumer.close(),
    ]);

    await this.publisher.close();
    if (!relayDrained && activeRelay !== undefined) {
      await this.waitForRelay(
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
    ])
      .then(([postgresql, rabbitmqPublisher, rabbitmqConsumer]) => {
        this.updateDependencyReadiness(postgresql, rabbitmqPublisher, rabbitmqConsumer);
      })
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
      const result = await this.relay.runOnce(this.workerId);
      if (result.publisherReady) {
        this.updateDependencyReadiness(true, true, this.consumer.isReady());
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
  }

  private updateDependencyReadiness(
    postgresql: boolean,
    rabbitmqPublisher: boolean,
    rabbitmqConsumer: boolean,
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
    this.health.updateDependencies({
      postgresql: { status: postgresql ? 'up' : 'down' },
      rabbitmqConsumer: { status: rabbitmqConsumer ? 'up' : 'down' },
      rabbitmqPublisher: { status: rabbitmqPublisher ? 'up' : 'down' },
    });
  }

  private async waitForRelay(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
