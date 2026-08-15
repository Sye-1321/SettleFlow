import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

import type {
  WebhookHttpClient,
  WebhookHttpFailureCode,
  WebhookHttpRequest,
  WebhookHttpResult,
} from './webhook-delivery.types';

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export interface NodeWebhookHttpClientOptions {
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)['code'];
  return typeof value === 'string' ? value : undefined;
}

function classifyTransportError(error: unknown): WebhookHttpFailureCode {
  const code = errorCode(error);
  if (code === 'SETTLEFLOW_WEBHOOK_TIMEOUT') return 'request_timeout';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'ESERVFAIL') {
    return 'dns_unavailable';
  }
  if (
    TLS_ERROR_CODES.has(code ?? '') ||
    /^(?:CERT_|CRL_|ERR_SSL_|ERR_TLS_|ERROR_IN_|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_|CERT_REVOKED|CERT_REJECTED|CERT_UNTRUSTED|SELF_SIGNED_|UNABLE_TO_)/u.test(
      code ?? '',
    )
  ) {
    return 'tls_verification_failed';
  }
  return 'network_error';
}

export class NodeWebhookHttpClient implements WebhookHttpClient {
  private readonly activeRequests = new Set<ClientRequest>();
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;

  public constructor(options: NodeWebhookHttpClientOptions = {}) {
    this.maxResponseBytes = options.maxResponseBytes ?? 65_536;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (this.maxResponseBytes !== 65_536 || this.timeoutMs !== 8_000) {
      throw new Error('Webhook HTTP resource limits must match ADR-0019');
    }
  }

  public abortActive(): void {
    for (const request of this.activeRequests) {
      const error = Object.assign(new Error('Webhook delivery shutdown'), {
        code: 'SETTLEFLOW_WEBHOOK_SHUTDOWN',
      });
      request.destroy(error);
    }
  }

  public deliver(input: WebhookHttpRequest): Promise<WebhookHttpResult> {
    return new Promise((resolve) => {
      const parsed = new URL(input.destination.url);
      const transport = parsed.protocol === 'https:' ? https : http;
      let settled = false;
      const state: { request?: ClientRequest; timeout?: NodeJS.Timeout } = {};

      const finish = (result: WebhookHttpResult): void => {
        if (settled) return;
        settled = true;
        if (state.timeout !== undefined) clearTimeout(state.timeout);
        if (state.request !== undefined) this.activeRequests.delete(state.request);
        resolve(result);
      };

      const options: RequestOptions = {
        agent: false,
        headers: input.headers,
        hostname: parsed.hostname,
        lookup: (_hostname, lookupOptions, callback): void => {
          const pinned = {
            address: input.destination.address,
            family: input.destination.family,
          };
          if (lookupOptions.all === true) {
            callback(null, [pinned]);
            return;
          }
          callback(null, pinned.address, pinned.family);
        },
        method: 'POST',
        path: `${parsed.pathname}${parsed.search}`,
        port: parsed.port === '' ? undefined : Number(parsed.port),
        protocol: parsed.protocol,
        ...(parsed.protocol === 'https:' ? { servername: input.destination.hostname } : {}),
      };

      const consumeResponse = (response: IncomingMessage): void => {
        const statusCode = response.statusCode ?? 0;
        const hash = createHash('sha256');
        let consumed = 0;
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          consumed += bytes.byteLength;
          if (consumed > this.maxResponseBytes) {
            finish({
              bodySha256: undefined,
              bodyTruncated: true,
              kind: 'response',
              statusCode,
            });
            response.destroy();
            return;
          }
          hash.update(bytes);
        });
        response.once('end', () => {
          finish({
            bodySha256: hash.digest(),
            bodyTruncated: false,
            kind: 'response',
            statusCode,
          });
        });
        response.once('error', (error: unknown) => {
          finish({ code: classifyTransportError(error), kind: 'failure' });
        });
      };

      const request = transport.request(options, consumeResponse);
      state.request = request;
      this.activeRequests.add(request);
      request.once('error', (error: unknown) => {
        finish({ code: classifyTransportError(error), kind: 'failure' });
      });
      const timeout = setTimeout(() => {
        const error = Object.assign(new Error('Webhook request timed out'), {
          code: 'SETTLEFLOW_WEBHOOK_TIMEOUT',
        });
        request.destroy(error);
      }, this.timeoutMs);
      state.timeout = timeout;
      timeout.unref();
      request.end(Buffer.from(input.body));
    });
  }
}

export const nodeWebhookHttpClientInternals = { classifyTransportError, TLS_ERROR_CODES };
