const DATABASE_UNAVAILABLE_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

const TRANSIENT_TRANSACTION_CODES = new Set(['40001', '40P01', '55P03', '57014', 'P2028', 'P2034']);

export class DatabaseUnavailableError extends Error {
  public constructor() {
    super('The database is unavailable');
    this.name = 'DatabaseUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function visitErrorGraph(error: unknown, visitor: (record: Record<string, unknown>) => void): void {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }

    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    visitor(current);
    for (const [key, value] of Object.entries(current)) {
      if (
        key === 'cause' ||
        key === 'driverAdapterError' ||
        key === 'error' ||
        key === 'errors' ||
        key === 'meta' ||
        key === 'originalError'
      ) {
        pending.push(value);
      }
    }
  }
}

export function hasDatabaseErrorCode(error: unknown, expected: ReadonlySet<string>): boolean {
  let found = false;
  visitErrorGraph(error, (record) => {
    for (const key of ['code', 'originalCode', 'sqlState', 'sqlstate']) {
      const value = record[key];
      if (typeof value === 'string' && expected.has(value)) {
        found = true;
      }
    }
  });
  return found;
}

export function findDatabaseConstraint(error: unknown): string | undefined {
  let constraint: string | undefined;
  visitErrorGraph(error, (record) => {
    if (constraint !== undefined) {
      return;
    }

    for (const key of ['constraint', 'constraintName', 'index']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        constraint = value;
        return;
      }
      if (isRecord(value)) {
        const fields = value['fields'];
        if (Array.isArray(fields) && fields.every((field) => typeof field === 'string')) {
          constraint = fields.join(',');
          return;
        }
      }
    }

    const target = record['target'];
    if (Array.isArray(target) && target.every((value) => typeof value === 'string')) {
      constraint = target.join(',');
    }
  });
  return constraint;
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  return hasDatabaseErrorCode(error, DATABASE_UNAVAILABLE_CODES);
}

export function isTransientTransactionError(error: unknown): boolean {
  return hasDatabaseErrorCode(error, TRANSIENT_TRANSACTION_CODES);
}
