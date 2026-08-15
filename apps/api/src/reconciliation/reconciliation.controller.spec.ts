import type { Response } from 'express';
import type { ReconciliationService } from '@settleflow/reconciliation';

import { REQUEST_ID } from '../http/request-id';
import { REQUIRED_MERCHANT_SCOPES_METADATA } from '../merchant-access/merchant-access.decorators';
import {
  reconciliationMultipartLimits,
  ReconciliationController,
} from './reconciliation.controller';

function handler(name: 'report' | 'stage'): object {
  return Object.getOwnPropertyDescriptor(ReconciliationController.prototype, name)!.value as object;
}

describe('ReconciliationController', () => {
  const identity = {
    apiKeyId: '00000000-0000-4000-8000-000000000021',
    merchantId: '00000000-0000-4000-8000-000000000022',
    scopes: ['reconciliation:write'] as const,
  };
  const file = {
    buffer: Buffer.from('fixture'),
    mimetype: 'text/csv',
    originalname: 'mock-provider.csv',
    size: 7,
  };

  it('uses exact UTC timestamps and authenticated merchant identity', async () => {
    const stage = jest.fn().mockResolvedValue({
      id: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'STAGED',
    });
    const controller = new ReconciliationController({ stage } as unknown as ReconciliationService);
    const status = jest.fn();
    const response = { status } as unknown as Response;
    const request = {
      body: {
        periodEnd: '2026-08-03T00:00:00.000Z',
        periodStart: '2026-08-02T00:00:00.000Z',
      },
      headers: {},
      rawHeaders: ['Idempotency-Key', 'reconciliation-key'],
      [REQUEST_ID]: 'req_123456789012345678901234',
    };

    await expect(controller.stage(file, request, response, identity)).resolves.toMatchObject({
      status: 'STAGED',
    });
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorApiKeyId: identity.apiKeyId,
        idempotencyKey: 'reconciliation-key',
        merchantId: identity.merchantId,
        periodEnd: new Date('2026-08-03T00:00:00.000Z'),
        periodStart: new Date('2026-08-02T00:00:00.000Z'),
        requestId: 'req_123456789012345678901234',
      }),
    );
    expect(status).toHaveBeenCalledWith(202);
  });

  it('rejects normalized-but-nonexistent calendar timestamps', async () => {
    const stage = jest.fn();
    const controller = new ReconciliationController({ stage } as unknown as ReconciliationService);
    const response = { status: jest.fn() } as unknown as Response;
    const request = {
      body: {
        periodEnd: '2026-03-03T00:00:00.000Z',
        periodStart: '2026-02-31T00:00:00.000Z',
      },
      headers: {},
      rawHeaders: ['Idempotency-Key', 'reconciliation-key'],
      requestId: 'req_reconciliation_invalid',
    };

    await expect(controller.stage(file, request, response, identity)).rejects.toBeDefined();
    expect(stage).not.toHaveBeenCalled();
  });

  it('declares independent write and read scopes', () => {
    expect(Reflect.getMetadata(REQUIRED_MERCHANT_SCOPES_METADATA, handler('stage'))).toEqual([
      'reconciliation:write',
    ]);
    expect(Reflect.getMetadata(REQUIRED_MERCHANT_SCOPES_METADATA, handler('report'))).toEqual([
      'reconciliation:read',
    ]);
  });

  it('bounds the exact two-field and one-file multipart contract without rejecting it', () => {
    expect(reconciliationMultipartLimits).toEqual({
      fields: 2,
      fileSize: 10 * 1024 * 1024,
      files: 1,
      parts: 4,
    });
  });
});
