import { trace } from '@opentelemetry/api';

import { redactTelemetryFields, type SafeTelemetryFields } from './redaction';
import { TelemetryContext } from './telemetry-context';

export type TelemetryLevel = 'debug' | 'error' | 'info' | 'warn';

export interface StructuredJsonLoggerOptions {
  readonly environment: 'development' | 'production' | 'test';
  readonly releaseCommit: string;
  readonly releaseVersion: string;
  readonly service: 'api' | 'worker';
  readonly sink?: (line: string) => void;
}

export class StructuredJsonLogger {
  private readonly sink: (line: string) => void;

  public constructor(
    private readonly options: StructuredJsonLoggerOptions,
    private readonly context = new TelemetryContext(),
  ) {
    this.sink =
      options.sink ??
      ((line): void => {
        process.stdout.write(`${line}\n`);
      });
  }

  public debug(message: unknown, ...optional: readonly unknown[]): void {
    this.write('debug', message, optional);
  }

  public error(message: unknown, ...optional: readonly unknown[]): void {
    this.write('error', message, optional);
  }

  public fatal(message: unknown, ...optional: readonly unknown[]): void {
    this.write('error', message, optional);
  }

  public log(message: unknown, ...optional: readonly unknown[]): void {
    this.write('info', message, optional);
  }

  public record(level: TelemetryLevel, fields: object): void {
    this.writeRecord(level, fields);
  }

  public verbose(message: unknown, ...optional: readonly unknown[]): void {
    this.write('debug', message, optional);
  }

  public warn(message: unknown, ...optional: readonly unknown[]): void {
    this.write('warn', message, optional);
  }

  private write(level: TelemetryLevel, message: unknown, optional: readonly unknown[]): void {
    let fields: Record<string, unknown> = {};
    if (isRecord(message)) fields = message;
    else if (typeof message === 'string') {
      try {
        const parsed: unknown = JSON.parse(message);
        fields = isRecord(parsed) ? parsed : { code: 'unstructured_log_dropped' };
      } catch {
        fields = { code: 'unstructured_log_dropped' };
      }
    }
    const contextName = [...optional]
      .reverse()
      .find((value): value is string => typeof value === 'string');
    this.writeRecord(
      level,
      contextName === undefined ? fields : { ...fields, context: contextName },
    );
  }

  private writeRecord(level: TelemetryLevel, fields: object): void {
    try {
      const activeSpan = trace.getActiveSpan()?.spanContext();
      const context = this.context.current();
      const record: SafeTelemetryFields = redactTelemetryFields({
        ...fields,
        ...context,
        environment: this.options.environment,
        level,
        releaseCommit: this.options.releaseCommit,
        releaseVersion: this.options.releaseVersion,
        service: this.options.service,
        spanId: activeSpan?.spanId,
        timestamp: new Date().toISOString(),
        traceId: activeSpan?.traceId,
      });
      this.sink(JSON.stringify(record));
    } catch {
      // Telemetry is disposable operational evidence and must never affect business work.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
