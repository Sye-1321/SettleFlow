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

const apiEnvironmentSchema = z
  .object({
    API_HOST: z.string().trim().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: databaseUrlSchema,
    DEPENDENCY_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    IDEMPOTENCY_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    IDEMPOTENCY_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    IDEMPOTENCY_REPLAY_TTL_HOURS: z.coerce.number().int().min(24).max(8_760).default(168),
    IDEMPOTENCY_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(10_000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RABBITMQ_URL: rabbitmqUrlSchema,
  })
  .superRefine((config, context) => {
    if (config.IDEMPOTENCY_LOCK_TIMEOUT_MS > config.IDEMPOTENCY_STATEMENT_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        message: 'IDEMPOTENCY_LOCK_TIMEOUT_MS must not exceed the statement timeout',
        path: ['IDEMPOTENCY_LOCK_TIMEOUT_MS'],
      });
    }
    if (config.IDEMPOTENCY_STATEMENT_TIMEOUT_MS >= config.IDEMPOTENCY_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        message: 'IDEMPOTENCY_STATEMENT_TIMEOUT_MS must be shorter than the owner lease',
        path: ['IDEMPOTENCY_STATEMENT_TIMEOUT_MS'],
      });
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

export function validateApiEnvironment(config: Record<string, unknown>): ApiEnvironment {
  const result = apiEnvironmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}
