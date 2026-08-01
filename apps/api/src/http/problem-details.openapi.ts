export const problemDetailsSchema = {
  additionalProperties: false,
  properties: {
    code: { example: 'invalid_request', type: 'string' },
    detail: { example: 'The request is invalid.', type: 'string' },
    requestId: { example: 'req_example-safe-value', type: 'string' },
    status: { example: 400, type: 'integer' },
    title: { example: 'Invalid request', type: 'string' },
    type: {
      example: 'https://docs.settleflow.dev/problems/invalid_request',
      format: 'uri',
      type: 'string',
    },
    violations: {
      items: {
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          reason: { enum: ['invalid'], type: 'string' },
        },
        required: ['field', 'reason'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['code', 'detail', 'requestId', 'status', 'title', 'type'],
  type: 'object',
};

export const problemContent = {
  'application/problem+json': { schema: problemDetailsSchema },
} as const;

export const requestIdResponseHeaders = {
  'X-Request-Id': {
    description: 'Canonical correlation ID for this HTTP attempt.',
    schema: { example: 'req_example-safe-value', type: 'string' },
  },
} as const;

export const conflictResponseHeaders = {
  ...requestIdResponseHeaders,
  'Retry-After': {
    description: 'Present with value 1 only while the idempotent command has an active owner.',
    schema: { example: '1', type: 'string' },
  },
} as const;
