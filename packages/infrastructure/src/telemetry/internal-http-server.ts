import { createServer, type Server } from 'node:http';

export interface InternalReadiness {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly ready: boolean;
}

export interface InternalHttpServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface InternalHealthSource {
  liveness(): object;
  readiness(): InternalReadiness | Promise<InternalReadiness>;
}

export class InternalHttpServer {
  private server: Server | undefined;

  public constructor(
    private readonly options: InternalHttpServerOptions,
    private readonly health: InternalHealthSource,
    private readonly metrics: () => Promise<{
      readonly body: string;
      readonly contentType: string;
    }>,
  ) {
    if (!isLoopbackHost(options.host)) throw new Error('Internal listener must bind to loopback');
  }

  public address(): { readonly address: string; readonly port: number } | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null
      ? { address: address.address, port: address.port }
      : undefined;
  }

  public close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  public start(): Promise<void> {
    if (this.server !== undefined) return Promise.resolve();
    const server = createServer((request, response) => {
      void this.respond(request.method, request.url, response);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const handleError = (error: Error): void => {
        server.off('listening', handleListening);
        this.server = undefined;
        reject(error);
      };
      const handleListening = (): void => {
        server.off('error', handleError);
        resolve();
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(this.options.port, this.options.host);
    });
  }

  private async respond(
    method: string | undefined,
    url: string | undefined,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (method !== 'GET') return sendJson(response, 405, { status: 'method_not_allowed' });
    const path = url?.split('?', 1)[0];
    try {
      if (path === '/health/live') return sendJson(response, 200, this.health.liveness());
      if (path === '/health/ready') {
        const readiness = await this.health.readiness();
        return sendJson(response, readiness.ready ? 200 : 503, {
          checks: readiness.checks,
          status: readiness.ready ? 'ready' : 'not_ready',
        });
      }
      if (path === '/metrics') {
        const metrics = await this.metrics();
        response.statusCode = 200;
        response.setHeader('Content-Type', metrics.contentType);
        response.end(metrics.body);
        return;
      }
      return sendJson(response, 404, { status: 'not_found' });
    } catch {
      return sendJson(response, 503, { status: 'not_ready' });
    }
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function sendJson(
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: object,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export const internalHttpInternals = { isLoopbackHost };
