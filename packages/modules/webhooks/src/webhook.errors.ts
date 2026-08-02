import { PermanentMessageProcessingError } from '@settleflow/eventing';

export class InvalidWebhookEndpointRequestError extends Error {
  public constructor(public readonly field?: string) {
    super('The webhook endpoint request is invalid');
    this.name = 'InvalidWebhookEndpointRequestError';
  }
}

export class UnsupportedWebhookEventError extends Error {
  public constructor() {
    super('The webhook event type is unsupported');
    this.name = 'UnsupportedWebhookEventError';
  }
}

export class WebhookEndpointNotFoundError extends Error {
  public constructor() {
    super('The webhook endpoint was not found');
    this.name = 'WebhookEndpointNotFoundError';
  }
}

export class WebhookEndpointUrlConflictError extends Error {
  public constructor() {
    super('The normalized webhook URL is already registered');
    this.name = 'WebhookEndpointUrlConflictError';
  }
}

export class WebhookEndpointUrlProhibitedError extends Error {
  public constructor() {
    super('The webhook endpoint URL is prohibited');
    this.name = 'WebhookEndpointUrlProhibitedError';
  }
}

export class WebhookEndpointUrlUnresolvableError extends Error {
  public constructor() {
    super('The webhook endpoint URL cannot be resolved');
    this.name = 'WebhookEndpointUrlUnresolvableError';
  }
}

export class WebhookEndpointUrlResolutionUnavailableError extends Error {
  public constructor() {
    super('Webhook endpoint DNS validation is unavailable');
    this.name = 'WebhookEndpointUrlResolutionUnavailableError';
  }
}

export class WebhookEndpointPreconditionRequiredError extends Error {
  public constructor() {
    super('An If-Match precondition is required');
    this.name = 'WebhookEndpointPreconditionRequiredError';
  }
}

export class WebhookEndpointPreconditionFailedError extends Error {
  public constructor() {
    super('The webhook endpoint precondition failed');
    this.name = 'WebhookEndpointPreconditionFailedError';
  }
}

export class WebhookEndpointIdentifierCollisionError extends Error {
  public constructor() {
    super('The webhook endpoint identifier collided');
    this.name = 'WebhookEndpointIdentifierCollisionError';
  }
}

export class WebhookEndpointIdentifierGenerationExhaustedError extends Error {
  public constructor() {
    super('Webhook endpoint identifier generation attempts were exhausted');
    this.name = 'WebhookEndpointIdentifierGenerationExhaustedError';
  }
}

export class WebhookKeyringUnavailableError extends Error {
  public constructor() {
    super('The webhook keyring is unavailable');
    this.name = 'WebhookKeyringUnavailableError';
  }
}

export class WebhookDeliveryIdentifierCollisionError extends Error {
  public constructor() {
    super('The webhook delivery identifier collided');
    this.name = 'WebhookDeliveryIdentifierCollisionError';
  }
}

export class WebhookDeliveryIdentifierGenerationExhaustedError extends PermanentMessageProcessingError {
  public constructor() {
    super('webhook_delivery_identifier_generation_exhausted');
    this.name = 'WebhookDeliveryIdentifierGenerationExhaustedError';
  }
}

export class WebhookEventProjectionConflictError extends PermanentMessageProcessingError {
  public constructor() {
    super('webhook_event_projection_identity_conflict');
    this.name = 'WebhookEventProjectionConflictError';
  }
}
