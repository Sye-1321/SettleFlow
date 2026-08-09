import { StructuredJsonLogger } from './structured-json-logger';
import { TelemetryContext } from './telemetry-context';

describe('StructuredJsonLogger', () => {
  it('emits one JSON object with context and removes prohibited or arbitrary data', () => {
    const lines: string[] = [];
    const context = new TelemetryContext();
    const logger = new StructuredJsonLogger(
      {
        environment: 'test',
        releaseCommit: 'abcdef0',
        releaseVersion: '1.0.0-test',
        service: 'api',
        sink: (line): void => {
          lines.push(line);
        },
      },
      context,
    );

    context.run({ requestId: 'req_safe' }, () => {
      logger.record('info', {
        amountMinor: 100,
        authorization: 'Bearer secret',
        durationMs: 12.5,
        event: 'http.request.completed',
        code: 'Bearer secret',
        nested: { token: 'secret' },
        route: '/v1/payment-intents',
      });
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      durationMs: 12.5,
      environment: 'test',
      event: 'http.request.completed',
      level: 'info',
      releaseCommit: 'abcdef0',
      releaseVersion: '1.0.0-test',
      requestId: 'req_safe',
      route: '/v1/payment-intents',
      service: 'api',
    });
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('amountMinor');
    expect(lines[0]).not.toContain('nested');
    expect(lines[0]).not.toContain('Bearer');
  });

  it('does not throw when its sink is unavailable', () => {
    const logger = new StructuredJsonLogger({
      environment: 'test',
      releaseCommit: 'local',
      releaseVersion: '0.0.0-test',
      service: 'worker',
      sink: (): never => {
        throw new Error('sink unavailable');
      },
    });

    expect(() => logger.record('error', { event: 'telemetry.export.failed' })).not.toThrow();
  });
});
