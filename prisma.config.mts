import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

const localEnvironmentPath = resolve(process.cwd(), '.env');
if (existsSync(localEnvironmentPath)) {
  process.loadEnvFile(localEnvironmentPath);
}

const databaseUrl = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl === undefined ? {} : { datasource: { url: databaseUrl } }),
});
