import { Injectable } from '@nestjs/common';
import type { DependencyReadiness, DependencyStatus } from '@settleflow/infrastructure';

type WorkerState = 'running' | 'starting' | 'stopping';

export interface WorkerLiveness {
  readonly service: 'worker';
  readonly status: 'ok';
}

export interface WorkerReadiness {
  readonly checks: {
    readonly configuration: 'up';
    readonly postgresql: DependencyStatus;
    readonly rabbitmq: DependencyStatus;
  };
  readonly service: 'worker';
  readonly status: 'not_ready' | 'ready';
}

@Injectable()
export class WorkerHealthService {
  private dependencies: DependencyReadiness = {
    postgresql: { status: 'down' },
    rabbitmq: { status: 'down' },
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
        rabbitmq: this.dependencies.rabbitmq.status,
      },
      service: 'worker',
      status:
        this.state === 'running' &&
        this.dependencies.postgresql.status === 'up' &&
        this.dependencies.rabbitmq.status === 'up'
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

  public updateDependencies(dependencies: DependencyReadiness): void {
    this.dependencies = dependencies;
  }
}
