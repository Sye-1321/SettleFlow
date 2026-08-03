import type { Channel, ConfirmChannel } from 'amqplib';

import type { DomainEventType } from './eventing.types';

const exchange = 'settleflow.domain-events';
const deadLetterExchange = 'settleflow.dead-letter';

export interface PaymentEventRoute {
  readonly deadLetterExchange: string;
  readonly deadLetterQueue: string;
  readonly deadLetterRoutingKey: string;
  readonly eventType: DomainEventType;
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: DomainEventType;
}

function route(eventType: DomainEventType): PaymentEventRoute {
  const suffix = eventType.replaceAll('.', '-').replace('-v1', '.v1');
  const queue = `settleflow.webhook-projection.${suffix}`;
  return {
    deadLetterExchange,
    deadLetterQueue: `${queue}.dlq`,
    deadLetterRoutingKey: queue,
    eventType,
    exchange,
    queue,
    routingKey: eventType,
  } as const;
}

export const PAYMENT_EVENT_ROUTES = {
  'payment.captured.v1': route('payment.captured.v1'),
  'payment.created.v1': route('payment.created.v1'),
  'payment.refunded.v1': route('payment.refunded.v1'),
  'settlement.finalized.v1': route('settlement.finalized.v1'),
  'reconciliation.completed.v1': route('reconciliation.completed.v1'),
} as const;

export const OUTBOX_RABBITMQ_TOPOLOGY = {
  ...PAYMENT_EVENT_ROUTES['payment.created.v1'],
  routes: PAYMENT_EVENT_ROUTES,
} as const;

export const SETTLEMENT_LIFECYCLE_ROUTE = {
  deadLetterExchange,
  deadLetterQueue: 'settleflow.settlement-projection.payment-lifecycle.v1.dlq',
  deadLetterRoutingKey: 'settleflow.settlement-projection.payment-lifecycle.v1',
  exchange,
  queue: 'settleflow.settlement-projection.payment-lifecycle.v1',
  routingKeys: ['payment.captured.v1', 'payment.refunded.v1'] as const,
} as const;

export function paymentEventRoute(eventType: DomainEventType): PaymentEventRoute {
  return PAYMENT_EVENT_ROUTES[eventType];
}

export async function assertOutboxRabbitMqTopology(
  channel: Channel | ConfirmChannel,
): Promise<void> {
  await channel.assertExchange(exchange, 'topic', { autoDelete: false, durable: true });
  await channel.assertExchange(deadLetterExchange, 'topic', {
    autoDelete: false,
    durable: true,
  });
  for (const eventRoute of Object.values(PAYMENT_EVENT_ROUTES)) {
    await channel.assertQueue(eventRoute.deadLetterQueue, {
      arguments: { 'x-queue-type': 'quorum' },
      autoDelete: false,
      durable: true,
      exclusive: false,
    });
    await channel.bindQueue(
      eventRoute.deadLetterQueue,
      deadLetterExchange,
      eventRoute.deadLetterRoutingKey,
    );
    await channel.assertQueue(eventRoute.queue, {
      arguments: {
        'x-dead-letter-exchange': deadLetterExchange,
        'x-dead-letter-routing-key': eventRoute.deadLetterRoutingKey,
        'x-queue-type': 'quorum',
      },
      autoDelete: false,
      durable: true,
      exclusive: false,
    });
    await channel.bindQueue(eventRoute.queue, exchange, eventRoute.routingKey);
  }
  await channel.assertQueue(SETTLEMENT_LIFECYCLE_ROUTE.deadLetterQueue, {
    arguments: { 'x-queue-type': 'quorum' },
    autoDelete: false,
    durable: true,
    exclusive: false,
  });
  await channel.bindQueue(
    SETTLEMENT_LIFECYCLE_ROUTE.deadLetterQueue,
    deadLetterExchange,
    SETTLEMENT_LIFECYCLE_ROUTE.deadLetterRoutingKey,
  );
  await channel.assertQueue(SETTLEMENT_LIFECYCLE_ROUTE.queue, {
    arguments: {
      'x-dead-letter-exchange': deadLetterExchange,
      'x-dead-letter-routing-key': SETTLEMENT_LIFECYCLE_ROUTE.deadLetterRoutingKey,
      'x-queue-type': 'quorum',
    },
    autoDelete: false,
    durable: true,
    exclusive: false,
  });
  for (const routingKey of SETTLEMENT_LIFECYCLE_ROUTE.routingKeys)
    await channel.bindQueue(SETTLEMENT_LIFECYCLE_ROUTE.queue, exchange, routingKey);
}
