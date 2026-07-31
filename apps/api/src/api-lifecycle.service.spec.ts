import type { DependencyConnections } from '@settleflow/infrastructure';

import { ApiLifecycleService } from './api-lifecycle.service';

describe('ApiLifecycleService', () => {
  it('closes dependency connections during application shutdown', async () => {
    const close = jest.fn((): Promise<void> => Promise.resolve());
    const dependencies = { close } as unknown as DependencyConnections;
    const lifecycle = new ApiLifecycleService(dependencies);

    await lifecycle.onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
