import { randomBytes } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';

export const REQUEST_ID = Symbol('settleflow.request-id');

export interface RequestWithRequestId {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawHeaders?: readonly string[];
  [REQUEST_ID]?: string;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function headerValues(
  request: Pick<RequestWithRequestId, 'headers' | 'rawHeaders'>,
  name: string,
): readonly string[] {
  const expected = name.toLowerCase();
  if (request.rawHeaders !== undefined) {
    const values: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === expected) {
        const value = request.rawHeaders[index + 1];
        if (value !== undefined) {
          values.push(value);
        }
      }
    }
    return values;
  }

  const value = request.headers[expected];
  if (typeof value === 'string') {
    return [value];
  }
  return value ?? [];
}

export function generateRequestId(): string {
  return `req_${randomBytes(18).toString('base64url')}`;
}

export function resolveRequestId(request: RequestWithRequestId): string {
  const values = headerValues(request, 'x-request-id');
  return values.length === 1 && REQUEST_ID_PATTERN.test(values[0] ?? '')
    ? values[0]!
    : generateRequestId();
}

export function getRequestId(request: RequestWithRequestId): string {
  return request[REQUEST_ID] ?? generateRequestId();
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware<RequestWithRequestId, HeaderResponse> {
  public use(
    request: RequestWithRequestId,
    response: HeaderResponse,
    next: (error?: unknown) => void,
  ): void {
    const requestId = resolveRequestId(request);
    Object.defineProperty(request, REQUEST_ID, {
      configurable: false,
      enumerable: false,
      value: requestId,
      writable: false,
    });
    response.setHeader('X-Request-Id', requestId);
    next();
  }
}

export const requestIdInternals = { REQUEST_ID_PATTERN };
