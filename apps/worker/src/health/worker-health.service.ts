import { Injectable } from '@nestjs/common';

type WorkerState = 'ready' | 'starting' | 'stopping';

export interface WorkerLiveness {
  readonly service: 'worker';
  readonly status: 'ok';
}

export interface WorkerReadiness {
  readonly checks: {
    readonly configuration: 'up';
  };
  readonly deferredDependencies: readonly ['postgresql', 'rabbitmq'];
  readonly service: 'worker';
  readonly status: 'not_ready' | 'ready';
}

@Injectable()
export class WorkerHealthService {
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
      },
      deferredDependencies: ['postgresql', 'rabbitmq'],
      service: 'worker',
      status: this.state === 'ready' ? 'ready' : 'not_ready',
    };
  }

  public markReady(): void {
    this.state = 'ready';
  }

  public markStopping(): void {
    this.state = 'stopping';
  }
}
