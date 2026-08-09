import { z } from 'zod';

const databaseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: 'DATABASE_URL must use postgres:// or postgresql://',
  });

const rabbitmqUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => ['amqp:', 'amqps:'].includes(new URL(value).protocol), {
    message: 'RABBITMQ_URL must use amqp:// or amqps://',
  });

const developmentOriginsSchema = z
  .string()
  .default('[]')
  .transform((value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a JSON array of canonical origins' });
      return z.NEVER;
    }
    if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== 'string')) {
      context.addIssue({ code: 'custom', message: 'must be a JSON array of canonical origins' });
      return z.NEVER;
    }
    return parsed as readonly string[];
  });

const exactBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const telemetryEndpointSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must use http:// or https://',
  });

const workerEnvironmentSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    DEPENDENCY_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    INTERNAL_TELEMETRY_ENABLED: exactBooleanSchema.optional(),
    INTERNAL_TELEMETRY_HOST: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
    INTERNAL_TELEMETRY_PORT: z.coerce.number().int().min(1).max(65_535).default(9_465),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(50),
    OUTBOX_RELAY_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    OUTBOX_RELAY_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
    OUTBOX_RELAY_RETRY_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RELAY_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
    OUTBOX_RELAY_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
    OTEL_DEMO_TRACE_MODE: exactBooleanSchema.default(false),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: telemetryEndpointSchema.optional(),
    OTEL_TRACE_EXPORT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5_000),
    OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0.1).max(0.1).default(0.1),
    OTEL_TRACING_ENABLED: exactBooleanSchema.default(false),
    RABBITMQ_URL: rabbitmqUrlSchema,
    RELEASE_COMMIT: z
      .string()
      .regex(/^(?:local|[a-f\d]{7,64})$/iu)
      .default('local'),
    RELEASE_VERSION: z
      .string()
      .regex(/^[a-z\d][a-z\d.+-]{0,63}$/iu)
      .default('0.0.0-dev'),
    RECONCILIATION_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
    SETTLEMENT_CONSUMER_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(16_384)
      .max(16_384)
      .default(16_384),
    SETTLEMENT_CONSUMER_PREFETCH: z.coerce.number().int().min(2).max(2).default(2),
    SETTLEMENT_CONSUMER_RECONNECT_BASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(1_000)
      .default(1_000),
    SETTLEMENT_CONSUMER_RECONNECT_MAX_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(60_000)
      .default(60_000),
    SETTLEMENT_CONSUMER_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10_000)
      .default(10_000),
    WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(8_000)
      .max(8_000)
      .default(8_000),
    WEBHOOK_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(4).max(4).default(4),
    WEBHOOK_DELIVERY_CONCURRENCY: z.coerce.number().int().min(4).max(4).default(4),
    WEBHOOK_DELIVERY_LEASE_MS: z.coerce.number().int().min(30_000).max(30_000).default(30_000),
    WEBHOOK_DELIVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(500).default(500),
    WEBHOOK_DELIVERY_RESPONSE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(65_536)
      .max(65_536)
      .default(65_536),
    WEBHOOK_DELIVERY_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10_000)
      .default(10_000),
    WEBHOOK_DELIVERY_TRANSACTION_RETRIES: z.coerce.number().int().min(3).max(3).default(3),
    WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS: developmentOriginsSchema,
    WEBHOOK_KEYRING_PROVIDER: z.literal('local'),
    WEBHOOK_LOCAL_ACTIVE_KEY_ID: z.string().min(1).max(64),
    WEBHOOK_LOCAL_KEYS_JSON: z.string().min(1).max(4_096),
    WEBHOOK_PROJECTION_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(16_384)
      .max(16_384)
      .default(16_384),
    WEBHOOK_PROJECTION_PREFETCH: z.coerce.number().int().min(2).max(2).default(2),
    WEBHOOK_PROJECTION_RECONNECT_BASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(1_000)
      .default(1_000),
    WEBHOOK_PROJECTION_RECONNECT_MAX_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(60_000)
      .default(60_000),
    WEBHOOK_PROJECTION_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10_000)
      .default(10_000),
    WEBHOOK_PROJECTION_TRANSACTION_RETRIES: z.coerce.number().int().min(3).max(3).default(3),
    WEBHOOK_URL_POLICY_MODE: z.enum(['development', 'production']).default('production'),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  })
  .superRefine((environment, context) => {
    if (environment.OUTBOX_RELAY_CONFIRM_TIMEOUT_MS >= environment.OUTBOX_RELAY_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        message: 'OUTBOX_RELAY_CONFIRM_TIMEOUT_MS must be shorter than OUTBOX_RELAY_LEASE_MS',
        path: ['OUTBOX_RELAY_CONFIRM_TIMEOUT_MS'],
      });
    }
    if (environment.OUTBOX_RELAY_RETRY_BASE_MS > environment.OUTBOX_RELAY_RETRY_MAX_MS) {
      context.addIssue({
        code: 'custom',
        message: 'OUTBOX_RELAY_RETRY_BASE_MS must not exceed OUTBOX_RELAY_RETRY_MAX_MS',
        path: ['OUTBOX_RELAY_RETRY_BASE_MS'],
      });
    }
    if (environment.WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS >= environment.WEBHOOK_DELIVERY_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        message: 'WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS must be shorter than the lease',
        path: ['WEBHOOK_DELIVERY_ATTEMPT_TIMEOUT_MS'],
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.WEBHOOK_URL_POLICY_MODE !== 'production'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production requires WEBHOOK_URL_POLICY_MODE=production',
        path: ['WEBHOOK_URL_POLICY_MODE'],
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production cannot configure development webhook origins',
        path: ['WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS'],
      });
    }
    if (environment.NODE_ENV === 'production' && environment.WEBHOOK_KEYRING_PROVIDER === 'local') {
      context.addIssue({
        code: 'custom',
        message: 'The local webhook keyring provider is forbidden in production',
        path: ['WEBHOOK_KEYRING_PROVIDER'],
      });
    }
    if (
      environment.OTEL_TRACING_ENABLED &&
      environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Tracing requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        path: ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
      });
    }
  })
  .transform((environment) => ({
    ...environment,
    INTERNAL_TELEMETRY_ENABLED:
      environment.INTERNAL_TELEMETRY_ENABLED ?? environment.NODE_ENV !== 'test',
  }));

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function validateWorkerEnvironment(config: Record<string, unknown>): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid worker environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
