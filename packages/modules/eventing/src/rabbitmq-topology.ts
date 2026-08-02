import type { Channel, ConfirmChannel } from 'amqplib';

export const OUTBOX_RABBITMQ_TOPOLOGY = {
  deadLetterExchange: 'settleflow.dead-letter',
  deadLetterQueue: 'settleflow.webhook-projection.payment-created.v1.dlq',
  deadLetterRoutingKey: 'settleflow.webhook-projection.payment-created.v1',
  exchange: 'settleflow.domain-events',
  queue: 'settleflow.webhook-projection.payment-created.v1',
  routingKey: 'payment.created.v1',
} as const;

export async function assertOutboxRabbitMqTopology(
  channel: Channel | ConfirmChannel,
): Promise<void> {
  await channel.assertExchange(OUTBOX_RABBITMQ_TOPOLOGY.exchange, 'topic', {
    autoDelete: false,
    durable: true,
  });
  await channel.assertExchange(OUTBOX_RABBITMQ_TOPOLOGY.deadLetterExchange, 'topic', {
    autoDelete: false,
    durable: true,
  });
  await channel.assertQueue(OUTBOX_RABBITMQ_TOPOLOGY.deadLetterQueue, {
    arguments: { 'x-queue-type': 'quorum' },
    autoDelete: false,
    durable: true,
    exclusive: false,
  });
  await channel.bindQueue(
    OUTBOX_RABBITMQ_TOPOLOGY.deadLetterQueue,
    OUTBOX_RABBITMQ_TOPOLOGY.deadLetterExchange,
    OUTBOX_RABBITMQ_TOPOLOGY.deadLetterRoutingKey,
  );
  await channel.assertQueue(OUTBOX_RABBITMQ_TOPOLOGY.queue, {
    arguments: {
      'x-dead-letter-exchange': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterExchange,
      'x-dead-letter-routing-key': OUTBOX_RABBITMQ_TOPOLOGY.deadLetterRoutingKey,
      'x-queue-type': 'quorum',
    },
    autoDelete: false,
    durable: true,
    exclusive: false,
  });
  await channel.bindQueue(
    OUTBOX_RABBITMQ_TOPOLOGY.queue,
    OUTBOX_RABBITMQ_TOPOLOGY.exchange,
    OUTBOX_RABBITMQ_TOPOLOGY.routingKey,
  );
}
