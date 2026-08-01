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

const workerEnvironmentSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    DEPENDENCY_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
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
    RABBITMQ_URL: rabbitmqUrlSchema,
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
  });

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function validateWorkerEnvironment(config: Record<string, unknown>): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid worker environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
