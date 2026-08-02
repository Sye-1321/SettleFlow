import { Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@settleflow/infrastructure';

type WorkerState = 'running' | 'starting' | 'stopping';

export interface WorkerLiveness {
  readonly service: 'worker';
  readonly status: 'ok';
}

export interface WorkerReadiness {
  readonly checks: {
    readonly configuration: 'up';
    readonly postgresql: DependencyStatus;
    readonly rabbitmqConsumer: DependencyStatus;
    readonly rabbitmqPublisher: DependencyStatus;
  };
  readonly service: 'worker';
  readonly status: 'not_ready' | 'ready';
}

@Injectable()
export class WorkerHealthService {
  private dependencies: {
    postgresql: { status: DependencyStatus };
    rabbitmqConsumer: { status: DependencyStatus };
    rabbitmqPublisher: { status: DependencyStatus };
  } = {
    postgresql: { status: 'down' },
    rabbitmqConsumer: { status: 'down' },
    rabbitmqPublisher: { status: 'down' },
  };
  private state: WorkerState = 'starting';

  public getLiveness(): WorkerLiveness {
    return {
      service: 'worker',
      status: 'ok',
    };
  }

  public getReadiness(): WorkerReadiness {
    return {
      checks: {
        configuration: 'up',
        postgresql: this.dependencies.postgresql.status,
        rabbitmqConsumer: this.dependencies.rabbitmqConsumer.status,
        rabbitmqPublisher: this.dependencies.rabbitmqPublisher.status,
      },
      service: 'worker',
      status:
        this.state === 'running' &&
        this.dependencies.postgresql.status === 'up' &&
        this.dependencies.rabbitmqConsumer.status === 'up' &&
        this.dependencies.rabbitmqPublisher.status === 'up'
          ? 'ready'
          : 'not_ready',
    };
  }

  public markRunning(): void {
    this.state = 'running';
  }

  public markStopping(): void {
    this.state = 'stopping';
  }

  public updateDependencies(dependencies: {
    readonly postgresql: { readonly status: DependencyStatus };
    readonly rabbitmqConsumer: { readonly status: DependencyStatus };
    readonly rabbitmqPublisher: { readonly status: DependencyStatus };
  }): void {
    this.dependencies = dependencies;
  }
}
