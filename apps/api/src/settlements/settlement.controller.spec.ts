import type { SettlementService } from '@settleflow/settlements';

import { REQUEST_ID } from '../http/request-id';
import { REQUIRED_MERCHANT_SCOPES_METADATA } from '../merchant-access/merchant-access.decorators';
import { SettlementController } from './settlement.controller';

function handler(name: 'getBatch' | 'run'): object {
  return Object.getOwnPropertyDescriptor(SettlementController.prototype, name)!.value as object;
}

describe('SettlementController', () => {
  const identity = {
    apiKeyId: '00000000-0000-4000-8000-000000000011',
    merchantId: '00000000-0000-4000-8000-000000000012',
    scopes: ['settlements:write'] as const,
  };

  it('uses authenticated merchant identity and the exact command contract', async () => {
    const run = jest.fn().mockResolvedValue({ id: 'str_01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    const controller = new SettlementController({ run } as unknown as SettlementService);
    const request = {
      headers: {},
      rawBody: Buffer.from('{"currency":"ETB","cutoffDate":"2026-08-02"}'),
      rawHeaders: ['Idempotency-Key', 'settlement-key'],
      [REQUEST_ID]: 'req_123456789012345678901234',
    };

    await expect(controller.run(request, identity)).resolves.toEqual({
      id: 'str_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(run).toHaveBeenCalledWith({
      actorApiKeyId: identity.apiKeyId,
      currency: 'ETB',
      cutoffDate: '2026-08-02',
      idempotencyKey: 'settlement-key',
      merchantId: identity.merchantId,
      requestId: 'req_123456789012345678901234',
    });
  });

  it('declares independent write and read scopes', () => {
    expect(Reflect.getMetadata(REQUIRED_MERCHANT_SCOPES_METADATA, handler('run'))).toEqual([
      'settlements:write',
    ]);
    expect(Reflect.getMetadata(REQUIRED_MERCHANT_SCOPES_METADATA, handler('getBatch'))).toEqual([
      'settlements:read',
    ]);
  });
});
