import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

const localEnvironmentPath = resolve(process.cwd(), '.env');
if (existsSync(localEnvironmentPath)) {
  process.loadEnvFile(localEnvironmentPath);
}

const databaseUrl = process.env['MIGRATION_DATABASE_URL'];

if (
  databaseUrl === undefined &&
  process.argv.some((argument) => argument === 'migrate' || argument === 'studio')
) {
  throw new Error(
    'MIGRATION_DATABASE_URL is required for Prisma migration and inspection commands',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl === undefined ? {} : { datasource: { url: databaseUrl } }),
});
