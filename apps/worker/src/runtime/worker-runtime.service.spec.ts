import type { ConfigService } from '@nestjs/config';
import type { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';

import type { WorkerEnvironment } from '../config/environment';
import { WorkerHealthService } from '../health/worker-health.service';
import { WorkerRuntimeService } from './worker-runtime.service';

describe('WorkerRuntimeService', () => {
  it('closes dependency connections during application shutdown', async () => {
    const closeDependencies = jest.fn((): Promise<void> => Promise.resolve());
    const closePrisma = jest.fn((): Promise<void> => Promise.resolve());
    const dependencies = { close: closeDependencies } as unknown as DependencyConnections;
    const prisma = { close: closePrisma } as unknown as PrismaDatabase;
    const config = {} as ConfigService<WorkerEnvironment, true>;
    const runtime = new WorkerRuntimeService(
      config,
      dependencies,
      prisma,
      new WorkerHealthService(),
    );

    await runtime.onApplicationShutdown();

    expect(closeDependencies).toHaveBeenCalledTimes(1);
    expect(closePrisma).toHaveBeenCalledTimes(1);
  });
});
