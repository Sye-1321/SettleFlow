import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';

const DELIVERY_ID_PATTERN = /^whd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SIGNATURE_PATTERN = /^v1,([A-Za-z0-9_-]{43})$/u;
const EVENT_TYPES = new Set([
  'payment.captured.v1',
  'payment.created.v1',
  'payment.refunded.v1',
  'reconciliation.completed.v1',
  'settlement.finalized.v1',
]);
const WAIT_ERROR_CODES = Object.freeze({
  'payment.captured.v1': 'demo_payment_captured_webhook_timeout',
  'payment.created.v1': 'demo_payment_created_webhook_timeout',
  'payment.refunded.v1': 'demo_payment_refunded_webhook_timeout',
  'reconciliation.completed.v1': 'demo_reconciliation_webhook_timeout',
  'settlement.finalized.v1': 'demo_settlement_webhook_timeout',
});
export const DEMO_RECEIVER_CONTROL_PATH = '/__settleflow_demo/receiver';
const HOOK_PATH_PATTERN = /^\/hooks\/[A-Za-z0-9_-]{16,64}$/u;
const SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/u;

function oneHeader(request, name) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function verifySignature({ body, deliveryId, nowEpochSeconds, secret, signature, timestamp }) {
  if (
    !DELIVERY_ID_PATTERN.test(deliveryId) ||
    !/^[1-9][0-9]*$/u.test(timestamp) ||
    !/^whsec_[A-Za-z0-9_-]{43}$/u.test(secret)
  ) {
    return false;
  }
  const timestampValue = BigInt(timestamp);
  if (timestampValue < nowEpochSeconds - 300n || timestampValue > nowEpochSeconds + 300n) {
    return false;
  }
  const input = Buffer.concat([
    Buffer.from(`${timestamp}.${deliveryId}.`, 'ascii'),
    Buffer.from(body),
  ]);
  const expected = createHmac('sha256', secret).update(input).digest();
  return signature.split(';').some((entry) => {
    const encoded = SIGNATURE_PATTERN.exec(entry)?.[1];
    if (encoded === undefined) return false;
    const candidate = Buffer.from(encoded, 'base64url');
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  });
}

export class SyntheticWebhookReceiver {
  #attempts = [];
  #controlPath;
  #failedOnce = false;
  #path;
  #port;
  #secret;
  #server;

  constructor({ controlPath, path, port }) {
    if (
      (path === undefined && controlPath === undefined) ||
      (path !== undefined && !HOOK_PATH_PATTERN.test(path)) ||
      (controlPath !== undefined && controlPath !== DEMO_RECEIVER_CONTROL_PATH)
    ) {
      throw new Error('demo_receiver_path_invalid');
    }
    this.#controlPath = controlPath;
    this.#path = path;
    this.#port = port;
  }

  setSecret(secret, path = this.#path) {
    if (
      this.#secret !== undefined ||
      !SECRET_PATTERN.test(secret) ||
      path === undefined ||
      !HOOK_PATH_PATTERN.test(path)
    ) {
      throw new Error('demo_receiver_secret_invalid');
    }
    this.#path = path;
    this.#secret = secret;
  }

  async start() {
    if (this.#server !== undefined) throw new Error('demo_receiver_already_started');
    this.#server = createServer((request, response) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16_384) request.destroy();
        else chunks.push(chunk);
      });
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        if (request.method === 'GET' && request.url === '/health/live') {
          response.writeHead(204).end();
          return;
        }
        if (this.#controlPath !== undefined && request.url === this.#controlPath) {
          if (request.method === 'GET') {
            const snapshot = Buffer.from(JSON.stringify(this.snapshot()), 'utf8');
            response
              .writeHead(200, {
                'Content-Length': String(snapshot.byteLength),
                'Content-Type': 'application/json',
              })
              .end(snapshot);
            return;
          }
          let configuration;
          try {
            configuration = JSON.parse(body.toString('utf8'));
          } catch {
            configuration = undefined;
          }
          if (
            request.method !== 'POST' ||
            oneHeader(request, 'content-type') !== 'application/json' ||
            typeof configuration !== 'object' ||
            configuration === null ||
            Object.keys(configuration).sort().join(',') !== 'path,secret' ||
            typeof configuration.path !== 'string' ||
            typeof configuration.secret !== 'string'
          ) {
            response.writeHead(400).end();
            return;
          }
          try {
            this.setSecret(configuration.secret, configuration.path);
          } catch {
            response.writeHead(409).end();
            return;
          }
          response.writeHead(204).end();
          return;
        }
        const deliveryId = oneHeader(request, 'settleflow-webhook-id') ?? '';
        const eventId = oneHeader(request, 'settleflow-event-id') ?? '';
        const eventType = oneHeader(request, 'settleflow-event-type') ?? '';
        const signature = oneHeader(request, 'settleflow-signature') ?? '';
        const timestamp = oneHeader(request, 'settleflow-timestamp') ?? '';
        const schemaVersion = oneHeader(request, 'settleflow-event-schema-version');
        const contentType = oneHeader(request, 'content-type');
        const contentLength = oneHeader(request, 'content-length');
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          parsed = undefined;
        }
        const valid =
          request.method === 'POST' &&
          request.url === this.#path &&
          this.#secret !== undefined &&
          EVENT_ID_PATTERN.test(eventId) &&
          DELIVERY_ID_PATTERN.test(deliveryId) &&
          EVENT_TYPES.has(eventType) &&
          schemaVersion === '1' &&
          contentType === 'application/json' &&
          contentLength === String(body.byteLength) &&
          typeof parsed === 'object' &&
          parsed !== null &&
          parsed.eventId === eventId &&
          parsed.eventType === eventType &&
          verifySignature({
            body,
            deliveryId,
            nowEpochSeconds: BigInt(Math.floor(Date.now() / 1_000)),
            secret: this.#secret,
            signature,
            timestamp,
          });
        if (!valid) {
          response.writeHead(400).end();
          return;
        }
        const bodySha256 = createHash('sha256').update(body).digest('hex');
        this.#attempts.push({
          bodySha256,
          deliveryId,
          eventId,
          eventType,
          succeeded: this.#failedOnce,
        });
        if (!this.#failedOnce) {
          this.#failedOnce = true;
          response.writeHead(503).end();
          return;
        }
        response.writeHead(204).end();
      });
    });
    await new Promise((resolveStart, rejectStart) => {
      this.#server.once('error', rejectStart);
      this.#server.listen(this.#port, '0.0.0.0', () => {
        this.#server.off('error', rejectStart);
        resolveStart();
      });
    });
  }

  snapshot() {
    return this.#attempts.map((attempt) => ({ ...attempt }));
  }

  async waitFor({ eventType, minimumSuccesses = 1, timeoutMs = 75_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = this.#attempts.filter(
        (attempt) => attempt.eventType === eventType && attempt.succeeded,
      );
      if (matches.length >= minimumSuccesses) return matches;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(WAIT_ERROR_CODES[eventType] ?? 'demo_webhook_wait_timeout');
  }

  assertSingleRetryThenSuccess() {
    const first = this.#attempts[0];
    const retry = this.#attempts.find(
      (attempt, index) =>
        index > 0 &&
        attempt.deliveryId === first?.deliveryId &&
        attempt.eventId === first.eventId &&
        attempt.bodySha256 === first.bodySha256 &&
        attempt.succeeded,
    );
    if (first?.succeeded !== false || retry === undefined) {
      throw new Error('demo_webhook_retry_not_proven');
    }
  }

  async close() {
    if (this.#server === undefined) return;
    const server = this.#server;
    this.#server = undefined;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      server.closeAllConnections();
    });
  }
}

export class ContainerWebhookReceiverClient {
  #attempts = [];
  #origin;

  constructor({ port }) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('demo_receiver_port_invalid');
    }
    this.#origin = `http://127.0.0.1:${String(port)}`;
  }

  async configure(path, secret) {
    const response = await globalThis.fetch(`${this.#origin}${DEMO_RECEIVER_CONTROL_PATH}`, {
      body: JSON.stringify({ path, secret }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: globalThis.AbortSignal.timeout(5_000),
    });
    if (response.status !== 204) throw new Error('demo_receiver_configuration_failed');
  }

  async refresh() {
    const response = await globalThis.fetch(`${this.#origin}${DEMO_RECEIVER_CONTROL_PATH}`, {
      signal: globalThis.AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) throw new Error('demo_receiver_evidence_unavailable');
    const attempts = await response.json();
    if (!Array.isArray(attempts)) throw new Error('demo_receiver_evidence_invalid');
    this.#attempts = attempts;
    return this.snapshot();
  }

  snapshot() {
    return this.#attempts.map((attempt) => ({ ...attempt }));
  }

  async waitFor({ eventType, minimumSuccesses = 1, timeoutMs = 75_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const attempts = await this.refresh();
      const matches = attempts.filter(
        (attempt) => attempt.eventType === eventType && attempt.succeeded === true,
      );
      if (matches.length >= minimumSuccesses) return matches;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(WAIT_ERROR_CODES[eventType] ?? 'demo_webhook_wait_timeout');
  }

  assertSingleRetryThenSuccess() {
    const first = this.#attempts[0];
    const retry = this.#attempts.find(
      (attempt, index) =>
        index > 0 &&
        attempt.deliveryId === first?.deliveryId &&
        attempt.eventId === first.eventId &&
        attempt.bodySha256 === first.bodySha256 &&
        attempt.succeeded === true,
    );
    if (first?.succeeded !== false || retry === undefined) {
      throw new Error('demo_webhook_retry_not_proven');
    }
  }

  close() {
    return Promise.resolve();
  }
}

export const webhookReceiverInternals = {
  DELIVERY_ID_PATTERN,
  EVENT_ID_PATTERN,
  EVENT_TYPES,
  HOOK_PATH_PATTERN,
  SECRET_PATTERN,
  verifySignature,
};
