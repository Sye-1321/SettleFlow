import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

export interface PrismaDatabaseOptions {
  readonly connectionTimeoutMs: number;
  readonly databaseUrl: string;
  readonly maxConnections?: number;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Prisma operation timed out'));
    }, timeoutMs);
    timeout.unref();
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

/**
 * Owns one lazy Prisma Client and driver adapter for an application process.
 * Nest registers this class as a singleton provider; module-owned adapters may
 * share the client instead of constructing additional pools.
 */
export class PrismaDatabase {
  private readonly client: PrismaClient;
  private readonly connectionTimeoutMs: number;
  private closePromise: Promise<void> | undefined;
  private connectPromise: Promise<void> | undefined;
  private closed = false;

  public constructor(options: PrismaDatabaseOptions) {
    this.connectionTimeoutMs = options.connectionTimeoutMs;
    const adapter = new PrismaPg({
      application_name: 'settleflow-prisma',
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: options.maxConnections ?? 5,
    });

    this.client = new PrismaClient({ adapter });
  }

  public getClient(): PrismaClient {
    if (this.closed) {
      throw new Error('Prisma database is closed');
    }

    return this.client;
  }

  public async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('Prisma database is closed');
    }

    this.connectPromise ??= withTimeout(this.client.$connect(), this.connectionTimeoutMs).catch(
      (error: unknown) => {
        this.connectPromise = undefined;
        throw error;
      },
    );
    await this.connectPromise;
  }

  public async checkConnectivity(): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    try {
      await this.connect();
      await withTimeout(this.client.$queryRaw`SELECT 1`, this.connectionTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    this.closePromise ??= this.disconnect();
    await this.closePromise;
  }

  private async disconnect(): Promise<void> {
    this.closed = true;
    await this.client.$disconnect();
  }
}
