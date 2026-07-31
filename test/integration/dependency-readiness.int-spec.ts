import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { DependencyConnections } from '@settleflow/infrastructure';

const POSTGRES_IMAGE =
  'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const RABBITMQ_IMAGE =
  'rabbitmq:4.3.4-management@sha256:4e628d3cbc61ef45c5918e19bb9844874410d96d4ced897ced7d072d63ad555c';

const RABBITMQ_USER = 'settleflow_test';
const RABBITMQ_PASSWORD = 'settleflow_test_only';

describe('DependencyConnections with real services', () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let rabbitmq: StartedRabbitMQContainer | undefined;

  beforeAll(async () => {
    [postgres, rabbitmq] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('settleflow_test')
        .withUsername('settleflow_test')
        .withPassword('settleflow_test_only')
        .start(),
      new RabbitMQContainer(RABBITMQ_IMAGE)
        .withEnvironment({
          RABBITMQ_DEFAULT_PASS: RABBITMQ_PASSWORD,
          RABBITMQ_DEFAULT_USER: RABBITMQ_USER,
        })
        .start(),
    ]);
  }, 120_000);

  afterAll(async () => {
    const stops: Promise<unknown>[] = [];
    if (rabbitmq !== undefined) {
      stops.push(rabbitmq.stop());
    }
    if (postgres !== undefined) {
      stops.push(postgres.stop());
    }
    await Promise.allSettled(stops);
  }, 120_000);

  it('reports ready with real PostgreSQL and RabbitMQ', async () => {
    if (postgres === undefined || rabbitmq === undefined) {
      throw new Error('Testcontainers did not start required dependencies');
    }

    const dependencies = new DependencyConnections({
      databaseUrl: postgres.getConnectionUri(),
      rabbitmqUrl: `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${rabbitmq.getHost()}:${rabbitmq.getMappedPort(5672)}`,
      timeoutMs: 5_000,
    });

    await expect(dependencies.checkReadiness()).resolves.toEqual({
      postgresql: { status: 'up' },
      rabbitmq: { status: 'up' },
    });
    await dependencies.close();
  });

  it('returns safe down statuses when dependencies are unavailable', async () => {
    const dependencies = new DependencyConnections({
      databaseUrl: 'postgresql://settleflow:test@127.0.0.1:1/settleflow',
      rabbitmqUrl: 'amqp://settleflow:test@127.0.0.1:1',
      timeoutMs: 250,
    });

    await expect(dependencies.checkReadiness()).resolves.toEqual({
      postgresql: { status: 'down' },
      rabbitmq: { status: 'down' },
    });
    await dependencies.close();
  });
});
