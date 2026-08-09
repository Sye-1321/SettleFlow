import type { TelemetryRuntime } from '@settleflow/infrastructure';

import { REQUEST_ID } from '../http/request-id';
import { ApiTelemetryMiddleware } from './api-telemetry.middleware';

describe('ApiTelemetryMiddleware', () => {
  it('records only the route template, status class, duration, and request context', async () => {
    const observeHttp = jest.fn();
    const record = jest.fn();
    const withContext = jest.fn((_context: object, callback: () => unknown) => callback());
    const telemetry = {
      logger: { record },
      metrics: { observeHttp },
      span: jest.fn(
        async (_name: string, _attributes: object, operation: (span: undefined) => Promise<void>) =>
          operation(undefined),
      ),
      withContext,
    } as unknown as TelemetryRuntime;
    const listeners = new Map<string, () => void>();
    const route: { path?: string } = {};
    const request = {
      [REQUEST_ID]: 'req_telemetry',
      baseUrl: '',
      headers: {},
      method: 'POST',
      route,
    };
    const response = {
      once: (event: string, callback: () => void): void => {
        listeners.set(event, callback);
      },
      statusCode: 201,
    };
    const middleware = new ApiTelemetryMiddleware(telemetry);

    middleware.use(request, response, () => {
      route.path = '/v1/payment-intents';
      listeners.get('finish')?.();
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(withContext).toHaveBeenCalledWith({ requestId: 'req_telemetry' }, expect.any(Function));
    expect(observeHttp).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', route: '/v1/payment-intents', statusClass: '2xx' }),
    );
    expect(record).toHaveBeenCalledWith(
      'info',
      expect.objectContaining({
        event: 'http.request.completed',
        method: 'POST',
        route: '/v1/payment-intents',
        statusClass: '2xx',
      }),
    );
  });
});
