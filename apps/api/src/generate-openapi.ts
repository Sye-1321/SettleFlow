import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { createOpenApiDocument } from './openapi';

const generationEnvironment: Readonly<Record<string, string>> = {
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/settleflow_openapi',
  DEPENDENCY_READINESS_TIMEOUT_MS: '100',
  NODE_ENV: 'test',
  RABBITMQ_URL: 'amqp://openapi:openapi@127.0.0.1:1/settleflow_openapi',
};

async function generate(): Promise<void> {
  for (const [key, value] of Object.entries(generationEnvironment)) {
    process.env[key] ??= value;
  }

  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
  try {
    const outputPath = resolve(process.cwd(), 'docs/api/openapi.json');
    const serialized = `${JSON.stringify(createOpenApiDocument(app), null, 2)}\n`;
    if (process.argv.includes('--check')) {
      const committed = await readFile(outputPath, 'utf8');
      if (committed !== serialized) {
        throw new Error('docs/api/openapi.json is stale; run pnpm openapi:generate');
      }
    } else {
      await writeFile(outputPath, serialized, 'utf8');
    }
  } finally {
    await app.close();
  }
}

void generate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown OpenAPI generation failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
