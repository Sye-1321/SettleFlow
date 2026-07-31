import type { ConfigService } from '@nestjs/config';
import type { DependencyConnections } from '@settleflow/infrastructure';

import type { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { WorkerRuntimeService } from './worker-runtime.service';

describe('WorkerRuntimeService', () => {
  it('closes dependency connections during application shutdown', async () => {
    const close = jest.fn((): Promise<void> => Promise.resolve());
    const dependencies = { close } as unknown as DependencyConnections;
    const config = {} as ConfigService<WorkerEnvironment, true>;
    const runtime = new WorkerRuntimeService(config, dependencies, new WorkerHealthService());

    await runtime.onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
