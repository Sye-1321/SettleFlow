export const webhookEndpointSchema = {
  additionalProperties: false,
  properties: {
    id: {
      example: 'whe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pattern: '^whe_[0-9A-HJKMNP-TV-Z]{26}$',
      type: 'string',
    },
    url: {
      example: 'https://merchant.example/webhooks/settleflow',
      maxLength: 2048,
      type: 'string',
    },
    status: { enum: ['active', 'inactive'], type: 'string' },
    subscriptions: {
      items: {
        enum: ['payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1'],
        type: 'string',
      },
      maxItems: 3,
      minItems: 1,
      type: 'array',
      uniqueItems: true,
    },
    version: { minimum: 0, type: 'integer' },
    createdAt: { format: 'date-time', type: 'string' },
    updatedAt: { format: 'date-time', type: 'string' },
  },
  required: ['id', 'url', 'status', 'subscriptions', 'version', 'createdAt', 'updatedAt'],
  type: 'object',
};

export const createWebhookEndpointSchema = {
  additionalProperties: false,
  properties: {
    url: { maxLength: 2048, minLength: 1, type: 'string' },
    subscriptions: {
      items: {
        enum: ['payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1'],
        type: 'string',
      },
      maxItems: 3,
      minItems: 1,
      type: 'array',
      uniqueItems: true,
    },
  },
  required: ['url', 'subscriptions'],
  type: 'object',
};

export const createdWebhookEndpointSchema = {
  ...webhookEndpointSchema,
  properties: {
    ...webhookEndpointSchema.properties,
    secret: {
      description: 'One-time signing secret. It cannot be retrieved again.',
      example: 'whsec_<one-time-secret>',
      type: 'string',
      'x-one-time-secret': true,
    },
  },
  required: [...webhookEndpointSchema.required, 'secret'],
};

export const patchWebhookEndpointSchema = {
  additionalProperties: false,
  anyOf: [{ required: ['status'] }, { required: ['subscriptions'] }],
  minProperties: 1,
  properties: {
    status: { enum: ['active', 'inactive'], type: 'string' },
    subscriptions: {
      items: {
        enum: ['payment.created.v1', 'payment.captured.v1', 'payment.refunded.v1'],
        type: 'string',
      },
      maxItems: 3,
      minItems: 1,
      type: 'array',
      uniqueItems: true,
    },
  },
  type: 'object',
};

export const webhookEndpointListSchema = {
  additionalProperties: false,
  properties: {
    data: { items: webhookEndpointSchema, type: 'array' },
    nextCursor: { nullable: true, type: 'string' },
  },
  required: ['data', 'nextCursor'],
  type: 'object',
};

export const rotatedWebhookSecretSchema = {
  additionalProperties: false,
  properties: {
    id: webhookEndpointSchema.properties.id,
    secret: {
      description: 'One-time new signing secret. It cannot be retrieved again.',
      example: 'whsec_<one-time-secret>',
      type: 'string',
      'x-one-time-secret': true,
    },
    previousSecretExpiresAt: { format: 'date-time', type: 'string' },
    version: { minimum: 1, type: 'integer' },
    updatedAt: { format: 'date-time', type: 'string' },
  },
  required: ['id', 'secret', 'previousSecretExpiresAt', 'version', 'updatedAt'],
  type: 'object',
};

export const etagResponseHeaders = {
  ETag: {
    description: 'Strong endpoint version, formatted as "<publicId>.v<version>".',
    schema: { example: '"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v0"', type: 'string' },
  },
  'X-Request-Id': {
    description: 'Canonical request correlation identifier.',
    schema: { type: 'string' },
  },
};
