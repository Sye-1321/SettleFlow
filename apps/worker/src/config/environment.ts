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

const workerEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  DEPENDENCY_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RABBITMQ_URL: rabbitmqUrlSchema,
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
});

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function validateWorkerEnvironment(config: Record<string, unknown>): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid worker environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
