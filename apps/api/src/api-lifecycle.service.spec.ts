import type { DependencyConnections, PrismaDatabase } from '@settleflow/infrastructure';

import { ApiLifecycleService } from './api-lifecycle.service';

describe('ApiLifecycleService', () => {
  it('closes dependency connections during application shutdown', async () => {
    const closeDependencies = jest.fn((): Promise<void> => Promise.resolve());
    const closePrisma = jest.fn((): Promise<void> => Promise.resolve());
    const dependencies = { close: closeDependencies } as unknown as DependencyConnections;
    const prisma = { close: closePrisma } as unknown as PrismaDatabase;
    const lifecycle = new ApiLifecycleService(dependencies, prisma);

    await lifecycle.onApplicationShutdown();

    expect(closeDependencies).toHaveBeenCalledTimes(1);
    expect(closePrisma).toHaveBeenCalledTimes(1);
  });
});
