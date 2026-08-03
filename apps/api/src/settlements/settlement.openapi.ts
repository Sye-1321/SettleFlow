const safeAmount = { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'integer' };

export const settlementRunSchema = {
  additionalProperties: false,
  properties: {
    batchId: { pattern: '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    completedAt: { format: 'date-time', type: 'string' },
    currency: { enum: ['ETB', 'USD'], type: 'string' },
    cutoffAt: { format: 'date-time', type: 'string' },
    cutoffDate: { format: 'date', type: 'string' },
    id: { pattern: '^str_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    moreEligible: { type: 'boolean' },
    status: { enum: ['COMPLETED', 'NO_ELIGIBLE_ITEMS'], type: 'string' },
  },
  required: ['completedAt', 'currency', 'cutoffAt', 'cutoffDate', 'id', 'moreEligible', 'status'],
  type: 'object',
};

const settlementItemSchema = {
  additionalProperties: false,
  properties: {
    feeAmountMinor: safeAmount,
    grossAmountMinor: { ...safeAmount, minimum: 1 },
    netAmountMinor: { ...safeAmount, minimum: 1 },
    paymentId: { pattern: '^pi_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
  },
  required: ['feeAmountMinor', 'grossAmountMinor', 'netAmountMinor', 'paymentId'],
  type: 'object',
};

const settlementAdjustmentSchema = {
  additionalProperties: false,
  properties: {
    adjustmentId: { pattern: '^sta_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    amountMinor: { ...safeAmount, minimum: 1 },
    refundId: { pattern: '^rf_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
  },
  required: ['adjustmentId', 'amountMinor', 'refundId'],
  type: 'object',
};

export const settlementBatchSchema = {
  additionalProperties: false,
  properties: {
    adjustmentAmountMinor: safeAmount,
    adjustmentCount: { maximum: 500, minimum: 0, type: 'integer' },
    adjustments: { items: settlementAdjustmentSchema, maxItems: 100, type: 'array' },
    createdAt: { format: 'date-time', type: 'string' },
    currency: { enum: ['ETB', 'USD'], type: 'string' },
    cutoffAt: { format: 'date-time', type: 'string' },
    feeAmountMinor: safeAmount,
    grossAmountMinor: { ...safeAmount, minimum: 1 },
    id: { pattern: '^stb_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    itemCount: { maximum: 500, minimum: 1, type: 'integer' },
    items: { items: settlementItemSchema, maxItems: 100, type: 'array' },
    ledgerTransactionId: { pattern: '^ltx_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    netAmountMinor: { ...safeAmount, minimum: 1 },
    nextCursor: { maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', type: 'string' },
    paymentGrossAmountMinor: { ...safeAmount, minimum: 1 },
    settledAt: { format: 'date-time', type: 'string' },
    status: { enum: ['SETTLED'], type: 'string' },
  },
  required: [
    'adjustmentAmountMinor',
    'adjustmentCount',
    'adjustments',
    'createdAt',
    'currency',
    'cutoffAt',
    'feeAmountMinor',
    'grossAmountMinor',
    'id',
    'itemCount',
    'items',
    'ledgerTransactionId',
    'netAmountMinor',
    'paymentGrossAmountMinor',
    'settledAt',
    'status',
  ],
  type: 'object',
};
