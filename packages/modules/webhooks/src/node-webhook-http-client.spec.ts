import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { NodeWebhookHttpClient, nodeWebhookHttpClientInternals } from './node-webhook-http-client';

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server has no port');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

describe('NodeWebhookHttpClient', () => {
  it.each(['CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER'])(
    'classifies %s as a terminal TLS failure',
    (code) => {
      expect(nodeWebhookHttpClientInternals.classifyTransportError({ code })).toBe(
        'tls_verification_failed',
      );
    },
  );

  it.each([
    ['SETTLEFLOW_WEBHOOK_TIMEOUT', 'request_timeout'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ECONNRESET', 'connection_reset'],
    ['EPIPE', 'connection_reset'],
    ['EAI_AGAIN', 'dns_unavailable'],
    ['ENOTFOUND', 'dns_unavailable'],
    ['ESERVFAIL', 'dns_unavailable'],
    ['UNKNOWN', 'network_error'],
  ] as const)('classifies %s transport evidence', (code, expected) => {
    expect(nodeWebhookHttpClientInternals.classifyTransportError({ code })).toBe(expected);
  });

  it('uses fixed ADR resource limits and rejects configuration drift', () => {
    expect(() => new NodeWebhookHttpClient({ maxResponseBytes: 1 })).toThrow('ADR-0019');
    expect(() => new NodeWebhookHttpClient({ timeoutMs: 1 })).toThrow('ADR-0019');
  });

  it('posts exact bytes and headers to one pinned address without following redirects', async () => {
    const received: { body: Buffer; headers: IncomingMessage['headers']; url: string }[] = [];
    const target = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks),
          headers: request.headers,
          url: request.url ?? '',
        });
        response.statusCode = 302;
        response.setHeader('Location', '/must-not-follow');
        response.end('redirect');
      });
    });
    try {
      const body = Buffer.from('{"exact":"bytes"}', 'utf8');
      const client = new NodeWebhookHttpClient();
      const result = await client.deliver({
        body,
        destination: {
          address: '127.0.0.1',
          family: 4,
          hostname: '127.0.0.1',
          url: `${target.origin}/hook?one=1`,
        },
        headers: {
          'Content-Length': String(body.byteLength),
          'Content-Type': 'application/json',
          'SettleFlow-Webhook-Id': 'whd_01K00000000000000000000000',
        },
      });

      expect(result).toMatchObject({ bodyTruncated: false, kind: 'response', statusCode: 302 });
      expect(received).toHaveLength(1);
      expect(received[0]?.body).toEqual(body);
      expect(received[0]?.url).toBe('/hook?one=1');
      expect(received[0]?.headers['settleflow-webhook-id']).toBe('whd_01K00000000000000000000000');
    } finally {
      await close(target.server);
    }
  });

  it('connects a hostname URL only to its pre-resolved pinned address', async () => {
    const target = await listen((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    try {
      const port = new URL(target.origin).port;
      const client = new NodeWebhookHttpClient();

      await expect(
        client.deliver({
          body: Buffer.from('{}'),
          destination: {
            address: '127.0.0.1',
            family: 4,
            hostname: 'demo-webhook-receiver',
            url: `http://demo-webhook-receiver:${port}/hook`,
          },
          headers: { 'Content-Length': '2' },
        }),
      ).resolves.toMatchObject({ kind: 'response', statusCode: 204 });
    } finally {
      await close(target.server);
    }
  });

  it('caps diagnostic response consumption at exactly 64 KiB', async () => {
    const target = await listen((_request, response) => {
      response.statusCode = 200;
      response.end(Buffer.alloc(65_537, 7));
    });
    try {
      const client = new NodeWebhookHttpClient();
      await expect(
        client.deliver({
          body: Buffer.from('{}'),
          destination: {
            address: '127.0.0.1',
            family: 4,
            hostname: '127.0.0.1',
            url: `${target.origin}/large`,
          },
          headers: { 'Content-Length': '2' },
        }),
      ).resolves.toEqual({
        bodySha256: undefined,
        bodyTruncated: true,
        kind: 'response',
        statusCode: 200,
      });
    } finally {
      await close(target.server);
    }
  });

  it('hashes a bounded response body as immutable attempt evidence', async () => {
    const target = await listen((_request, response) => {
      response.statusCode = 204;
      response.end('evidence');
    });
    try {
      const client = new NodeWebhookHttpClient();
      const result = await client.deliver({
        body: Buffer.from('{}'),
        destination: {
          address: '127.0.0.1',
          family: 4,
          hostname: '127.0.0.1',
          url: `${target.origin}/hash`,
        },
        headers: { 'Content-Length': '2' },
      });
      expect(result).toMatchObject({ bodyTruncated: false, kind: 'response', statusCode: 204 });
      expect(result.kind === 'response' ? result.bodySha256 : undefined).toHaveLength(32);
    } finally {
      await close(target.server);
    }
  });
});
