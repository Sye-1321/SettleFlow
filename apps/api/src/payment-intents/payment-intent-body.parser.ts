import { isLosslessNumber, parse, parseLosslessNumber } from 'lossless-json';
import {
  InvalidPaymentIntentRequestError,
  validatePaymentIntentFields,
  type ValidatedPaymentIntentFields,
} from '@settleflow/payments';

const EXPECTED_FIELDS = ['amountMinor', 'captureMethod', 'currency', 'externalRef'] as const;
const JSON_NUMBER_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;
const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);

function assertNoDuplicateTopLevelKeys(text: string): void {
  const keys = new Set<string>();
  let depth = 0;
  let escaped = false;
  let expectingKey = false;
  let inString = false;
  let keyStart: number | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (keyStart !== undefined) {
          const key = JSON.parse(text.slice(keyStart, index + 1)) as unknown;
          if (typeof key !== 'string' || keys.has(key)) {
            throw new InvalidPaymentIntentRequestError();
          }
          keys.add(key);
          keyStart = undefined;
          expectingKey = false;
        }
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      if (depth === 1 && expectingKey) {
        keyStart = index;
      }
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth === 1 && character === '{') {
        expectingKey = true;
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      expectingKey = true;
    }
  }
}

function toExponent(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/u, '').replace(/^0+/u, '') || '0';
  if (unsigned.length > 6) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }
  const exponent = Number(unsigned);
  return negative ? -exponent : exponent;
}

export function exactSafeIntegerFromToken(token: string): number {
  const match = JSON_NUMBER_PATTERN.exec(token);
  if (match === null || match[1] === '-') {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }

  const integerPart = match[2]!;
  const fractionPart = match[3] ?? '';
  const combined = `${integerPart}${fractionPart}`;
  if (!/[1-9]/u.test(combined)) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }

  const decimalPosition = integerPart.length + toExponent(match[4]);
  let integerDigits: string;
  if (decimalPosition <= 0) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }
  if (decimalPosition < combined.length) {
    if (!/^0*$/u.test(combined.slice(decimalPosition))) {
      throw new InvalidPaymentIntentRequestError('amountMinor');
    }
    integerDigits = combined.slice(0, decimalPosition);
  } else {
    const significant = combined.replace(/^0+/u, '');
    const zeroCount = decimalPosition - combined.length;
    if (significant.length + zeroCount > MAX_SAFE_INTEGER_TEXT.length) {
      throw new InvalidPaymentIntentRequestError('amountMinor');
    }
    integerDigits = `${significant}${'0'.repeat(zeroCount)}`;
  }

  const canonical = integerDigits.replace(/^0+/u, '');
  if (
    canonical.length === 0 ||
    canonical.length > MAX_SAFE_INTEGER_TEXT.length ||
    (canonical.length === MAX_SAFE_INTEGER_TEXT.length && canonical > MAX_SAFE_INTEGER_TEXT)
  ) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }

  const amountMinor = Number(canonical);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }
  return amountMinor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePaymentIntentBody(rawBody: Buffer): ValidatedPaymentIntentFields {
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    assertNoDuplicateTopLevelKeys(text);
    parsed = parse(text, null, {
      onDuplicateKey: () => {
        throw new InvalidPaymentIntentRequestError();
      },
      parseNumber: parseLosslessNumber,
    });
  } catch {
    throw new InvalidPaymentIntentRequestError();
  }
  if (!isPlainObject(parsed)) {
    throw new InvalidPaymentIntentRequestError();
  }

  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== EXPECTED_FIELDS.length ||
    EXPECTED_FIELDS.some((field, index) => keys[index] !== field)
  ) {
    throw new InvalidPaymentIntentRequestError();
  }

  const amount = parsed['amountMinor'];
  if (!isLosslessNumber(amount)) {
    throw new InvalidPaymentIntentRequestError('amountMinor');
  }

  return validatePaymentIntentFields({
    amountMinor: exactSafeIntegerFromToken(amount.toString()),
    captureMethod: parsed['captureMethod'],
    currency: parsed['currency'],
    externalRef: parsed['externalRef'],
  });
}

export const paymentIntentBodyParserInternals = {
  EXPECTED_FIELDS,
  assertNoDuplicateTopLevelKeys,
  toExponent,
};
