export const paymentIntentSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: { example: 125000, maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
    captureMethod: { enum: ['manual'], example: 'manual', type: 'string' },
    capturedAmountMinor: {
      example: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 0,
      type: 'integer',
    },
    createdAt: { example: '2026-08-01T10:20:12.345Z', format: 'date-time', type: 'string' },
    currency: { enum: ['ETB', 'USD'], example: 'ETB', type: 'string' },
    externalRef: { example: 'order_1001', maxLength: 255, minLength: 1, type: 'string' },
    id: {
      example: 'pi_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pattern: '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
      type: 'string',
    },
    paymentStatus: {
      enum: ['created', 'captured', 'partially_refunded', 'refunded'],
      example: 'created',
      type: 'string',
    },
    refundedAmountMinor: {
      example: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 0,
      type: 'integer',
    },
    settlementStatus: { enum: ['NOT_ELIGIBLE'], example: 'NOT_ELIGIBLE', type: 'string' },
    updatedAt: { example: '2026-08-01T10:20:12.345Z', format: 'date-time', type: 'string' },
    version: { example: 0, minimum: 0, type: 'integer' },
  },
  required: [
    'amountMinor',
    'captureMethod',
    'capturedAmountMinor',
    'createdAt',
    'currency',
    'externalRef',
    'id',
    'paymentStatus',
    'refundedAmountMinor',
    'settlementStatus',
    'updatedAt',
    'version',
  ],
  type: 'object',
};

export const createPaymentIntentSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: { example: 125000, maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
    captureMethod: { enum: ['manual'], example: 'manual', type: 'string' },
    currency: { enum: ['ETB', 'USD'], example: 'ETB', type: 'string' },
    externalRef: { example: 'order_1001', maxLength: 255, minLength: 1, type: 'string' },
  },
  required: ['amountMinor', 'captureMethod', 'currency', 'externalRef'],
  type: 'object',
};

export const capturePaymentIntentSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: { example: 125000, maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
    currency: { enum: ['ETB', 'USD'], example: 'ETB', type: 'string' },
  },
  required: ['amountMinor', 'currency'],
  type: 'object',
};

export const capturedPaymentIntentSchema = {
  ...paymentIntentSchema,
  properties: {
    ...paymentIntentSchema.properties,
    ledgerTransactionId: {
      example: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pattern: '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
      type: 'string',
    },
    paymentStatus: { enum: ['captured'], example: 'captured', type: 'string' },
  },
  required: [...paymentIntentSchema.required, 'ledgerTransactionId'],
};

export const refundPaymentIntentSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: { example: 25000, maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
    currency: { enum: ['ETB', 'USD'], example: 'ETB', type: 'string' },
    externalRef: { example: 'refund_1001', maxLength: 255, minLength: 1, type: 'string' },
  },
  required: ['amountMinor', 'currency', 'externalRef'],
  type: 'object',
};

export const refundSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: { example: 25000, maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' },
    createdAt: { example: '2026-08-02T11:20:12.345Z', format: 'date-time', type: 'string' },
    cumulativeRefundedAmountMinor: {
      example: 25000,
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 1,
      type: 'integer',
    },
    currency: { enum: ['ETB', 'USD'], example: 'ETB', type: 'string' },
    externalRef: { example: 'refund_1001', maxLength: 255, minLength: 1, type: 'string' },
    id: {
      example: 'rf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pattern: '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
      type: 'string',
    },
    ledgerTransactionId: {
      example: 'ltx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pattern: '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$',
      type: 'string',
    },
    paymentId: paymentIntentSchema.properties.id,
    paymentStatus: {
      enum: ['partially_refunded', 'refunded'],
      example: 'partially_refunded',
      type: 'string',
    },
  },
  required: [
    'amountMinor',
    'createdAt',
    'cumulativeRefundedAmountMinor',
    'currency',
    'externalRef',
    'id',
    'ledgerTransactionId',
    'paymentId',
    'paymentStatus',
  ],
  type: 'object',
};
