import * as amqp from 'amqplib';
import type { ChannelModel } from 'amqplib';
import { Pool } from 'pg';

export type DependencyStatus = 'down' | 'up';

export interface DependencyCheck {
  readonly status: DependencyStatus;
}

export interface DependencyReadiness {
  readonly postgresql: DependencyCheck;
  readonly rabbitmq: DependencyCheck;
}

export interface DependencyConnectionOptions {
  readonly databaseUrl: string;
  readonly rabbitmqUrl: string;
  readonly timeoutMs: number;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Dependency operation timed out'));
    }, timeoutMs);
    timeout.unref();
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

export function areRequiredDependenciesReady(readiness: DependencyReadiness): boolean {
  return readiness.postgresql.status === 'up' && readiness.rabbitmq.status === 'up';
}

export class DependencyConnections {
  private readonly pool: Pool;
  private readonly rabbitmqUrl: string;
  private readonly timeoutMs: number;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private rabbitConnection: ChannelModel | undefined;
  private rabbitConnectionPromise: Promise<ChannelModel> | undefined;

  public constructor(options: DependencyConnectionOptions) {
    this.rabbitmqUrl = options.rabbitmqUrl;
    this.timeoutMs = options.timeoutMs;
    this.pool = new Pool({
      application_name: 'settleflow-readiness',
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: options.timeoutMs,
      idleTimeoutMillis: 30_000,
      max: 2,
    });

    // node-postgres emits idle-client errors on the pool. Readiness observes the
    // resulting failed query; this listener prevents an unhandled process error.
    this.pool.on('error', () => undefined);
  }

  public async checkReadiness(): Promise<DependencyReadiness> {
    const [postgresql, rabbitmq] = await Promise.all([
      this.checkPostgreSql(),
      this.checkRabbitMq(),
    ]);

    return { postgresql, rabbitmq };
  }

  public async close(): Promise<void> {
    this.closePromise ??= this.closeConnections();
    await this.closePromise;
  }

  private async checkPostgreSql(): Promise<DependencyCheck> {
    if (this.closed) {
      return { status: 'down' };
    }

    try {
      await withTimeout(this.pool.query('SELECT 1'), this.timeoutMs);
      return { status: 'up' };
    } catch {
      return { status: 'down' };
    }
  }

  private async checkRabbitMq(): Promise<DependencyCheck> {
    if (this.closed) {
      return { status: 'down' };
    }

    try {
      const connection = await withTimeout(this.getRabbitConnection(), this.timeoutMs);
      const channel = await withTimeout(connection.createChannel(), this.timeoutMs);
      await withTimeout(channel.close(), this.timeoutMs);
      return { status: 'up' };
    } catch {
      await this.discardRabbitConnection();
      return { status: 'down' };
    }
  }

  private async getRabbitConnection(): Promise<ChannelModel> {
    if (this.closed) {
      throw new Error('Dependency connections are closed');
    }

    if (this.rabbitConnection !== undefined) {
      return this.rabbitConnection;
    }

    this.rabbitConnectionPromise ??= amqp
      .connect(this.rabbitmqUrl, { timeout: this.timeoutMs })
      .then(async (connection) => {
        if (this.closed) {
          await connection.close();
          throw new Error('Dependency connections are closed');
        }

        const clearConnection = (): void => {
          if (this.rabbitConnection === connection) {
            this.rabbitConnection = undefined;
          }
        };

        connection.on('close', clearConnection);
        connection.on('error', clearConnection);
        this.rabbitConnection = connection;
        return connection;
      })
      .finally(() => {
        this.rabbitConnectionPromise = undefined;
      });

    return this.rabbitConnectionPromise;
  }

  private async discardRabbitConnection(): Promise<void> {
    const connection = this.rabbitConnection;
    this.rabbitConnection = undefined;

    if (connection !== undefined) {
      try {
        await withTimeout(connection.close(), this.timeoutMs);
      } catch {
        // The connection is already unusable; clearing the reference is sufficient.
      }
    }
  }

  private async closeConnections(): Promise<void> {
    this.closed = true;
    await this.discardRabbitConnection();
    await this.pool.end();
  }
}
