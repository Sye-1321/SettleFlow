const count = { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'integer' };

export const reconciliationUploadSchema = {
  additionalProperties: false,
  properties: {
    file: { format: 'binary', type: 'string' },
    periodEnd: { example: '2026-08-04T00:00:00.000Z', format: 'date-time', type: 'string' },
    periodStart: { example: '2026-08-01T00:00:00.000Z', format: 'date-time', type: 'string' },
  },
  required: ['file', 'periodEnd', 'periodStart'],
  type: 'object',
};

export const reconciliationImportSchema = {
  additionalProperties: false,
  properties: {
    createdAt: { format: 'date-time', type: 'string' },
    id: { pattern: '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    periodEnd: { format: 'date-time', type: 'string' },
    periodStart: { format: 'date-time', type: 'string' },
    rowCount: { maximum: 50_000, minimum: 0, type: 'integer' },
    status: { enum: ['COMPLETED', 'FAILED', 'STAGED'], type: 'string' },
  },
  required: ['createdAt', 'id', 'periodEnd', 'periodStart', 'rowCount', 'status'],
  type: 'object',
};

const summary = {
  additionalProperties: false,
  properties: {
    amountMismatchCount: count,
    currency: { enum: ['ETB', 'USD'], type: 'string' },
    currencyMismatchCount: count,
    duplicateProviderRowCount: count,
    matchedExactCount: count,
    platformOnlyCount: count,
    providerOnlyCount: count,
    statusMismatchCount: count,
    unexplainedDifferenceMinor: {
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: Number.MIN_SAFE_INTEGER,
      type: 'integer',
    },
  },
  required: [
    'amountMismatchCount',
    'currency',
    'currencyMismatchCount',
    'duplicateProviderRowCount',
    'matchedExactCount',
    'platformOnlyCount',
    'providerOnlyCount',
    'statusMismatchCount',
    'unexplainedDifferenceMinor',
  ],
  type: 'object',
};

export const reconciliationReportSchema = {
  additionalProperties: false,
  properties: {
    id: { pattern: '^rec_[0-7][0-9A-HJKMNP-TV-Z]{25}$', type: 'string' },
    mismatches: {
      items: {
        additionalProperties: false,
        properties: {
          bucket: {
            enum: [
              'amount_mismatch',
              'currency_mismatch',
              'duplicate_provider_row',
              'platform_only',
              'provider_only',
              'status_mismatch',
            ],
            type: 'string',
          },
          platformPublicRef: { maxLength: 255, type: 'string' },
          reasonCode: { maxLength: 64, type: 'string' },
        },
        required: ['bucket', 'reasonCode'],
        type: 'object',
      },
      maxItems: 100,
      type: 'array',
    },
    nextCursor: { maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', type: 'string' },
    status: { enum: ['COMPLETED'], type: 'string' },
    summaries: { items: summary, maxItems: 2, minItems: 2, type: 'array' },
  },
  required: ['id', 'mismatches', 'status', 'summaries'],
  type: 'object',
};
