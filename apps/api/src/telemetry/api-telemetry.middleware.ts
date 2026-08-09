import { Injectable, type NestMiddleware } from '@nestjs/common';
import { TelemetryRuntime } from '@settleflow/infrastructure';

import { getRequestId, type RequestWithRequestId } from '../http/request-id';

interface TelemetryRequest extends RequestWithRequestId {
  readonly baseUrl?: string;
  readonly method?: string;
  readonly route?: { readonly path?: string };
}

interface TelemetryResponse {
  readonly statusCode: number;
  once(event: 'close' | 'finish', callback: () => void): void;
}

@Injectable()
export class ApiTelemetryMiddleware implements NestMiddleware<TelemetryRequest, TelemetryResponse> {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public use(
    request: TelemetryRequest,
    response: TelemetryResponse,
    next: (error?: unknown) => void,
  ): void {
    const requestId = getRequestId(request);
    const method = request.method?.toUpperCase() ?? 'GET';
    const startedAt = process.hrtime.bigint();
    void this.telemetry.withContext({ requestId }, () =>
      this.telemetry
        .span(
          'http.request',
          { 'http.method': method, operation: 'http.request' },
          (span) =>
            new Promise<void>((resolve, reject) => {
              let completed = false;
              const complete = (): void => {
                if (completed) return;
                completed = true;
                const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
                const route = routeTemplate(request);
                const statusClass = `${Math.floor(response.statusCode / 100)}xx`;
                span?.setAttributes({
                  'http.route': route,
                  'http.status_class': statusClass,
                });
                this.telemetry.metrics.observeHttp({ durationMs, method, route, statusClass });
                this.telemetry.logger.record('info', {
                  durationMs,
                  event: 'http.request.completed',
                  method,
                  route,
                  statusClass,
                });
                if (response.statusCode >= 500) reject(new Error('HTTP server error'));
                else resolve();
              };
              response.once('finish', complete);
              response.once('close', complete);
              try {
                next();
              } catch (error: unknown) {
                reject(error instanceof Error ? error : new Error('HTTP middleware failure'));
              }
            }),
        )
        .catch(() => undefined),
    );
  }
}

function routeTemplate(request: TelemetryRequest): string {
  const route = request.route?.path;
  if (typeof route !== 'string') return 'unmatched';
  const base = request.baseUrl ?? '';
  return `${base}${route}`.replace(/\/+/gu, '/');
}

export const apiTelemetryInternals = { routeTemplate };
