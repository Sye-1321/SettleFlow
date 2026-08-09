import { AsyncLocalStorage } from 'node:async_hooks';

export interface TelemetryContextValue {
  readonly eventId?: string;
  readonly merchantId?: string;
  readonly requestId?: string;
  readonly safeResourceId?: string;
}

export class TelemetryContext {
  private readonly storage = new AsyncLocalStorage<TelemetryContextValue>();

  public current(): TelemetryContextValue {
    return this.storage.getStore() ?? {};
  }

  public enrich(values: TelemetryContextValue): void {
    const current = this.storage.getStore();
    if (current === undefined) return;
    this.storage.enterWith({ ...current, ...definedValues(values) });
  }

  public run<T>(values: TelemetryContextValue, callback: () => T): T {
    return this.storage.run(definedValues(values), callback);
  }
}

function definedValues(values: TelemetryContextValue): TelemetryContextValue {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
