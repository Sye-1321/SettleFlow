import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MerchantAccessService, MerchantRequestIdentity } from '@settleflow/merchant-access';

import { MerchantApiKeyGuard, merchantApiKeyGuardInternals } from './merchant-api-key.guard';
import { MERCHANT_REQUEST_IDENTITY, MerchantAuthenticatedRequest } from './merchant-request';

describe('MerchantApiKeyGuard', () => {
  const identity: MerchantRequestIdentity = {
    apiKeyId: 'key-id',
    merchantId: 'merchant-id',
    scopes: ['payments:read'],
  };

  function createHarness(options: {
    readonly authorization?: string;
    readonly authenticated?: MerchantRequestIdentity;
    readonly isPublic?: boolean;
    readonly requiredScopes?: readonly ('payments:read' | 'payments:write')[];
  }): {
    readonly context: ExecutionContext;
    readonly guard: MerchantApiKeyGuard;
    readonly merchantAccess: jest.Mocked<MerchantAccessService>;
    readonly request: MerchantAuthenticatedRequest;
  } {
    const request: MerchantAuthenticatedRequest = {
      headers: options.authorization === undefined ? {} : { authorization: options.authorization },
    };
    const context = {
      getClass: jest.fn(),
      getHandler: jest.fn(),
      switchToHttp: (): { getRequest: () => MerchantAuthenticatedRequest } => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(options.isPublic ?? false)
        .mockReturnValueOnce(options.requiredScopes ?? []),
    } as unknown as Reflector;
    const merchantAccess = {
      authenticate: jest.fn().mockResolvedValue(options.authenticated),
      hasScopes: jest
        .fn()
        .mockImplementation((_identity, required) =>
          (required as readonly string[]).every(
            (scope) =>
              options.authenticated?.scopes.some((grantedScope) => grantedScope === scope) === true,
          ),
        ),
    } as unknown as jest.Mocked<MerchantAccessService>;

    return {
      context,
      guard: new MerchantApiKeyGuard(merchantAccess, reflector),
      merchantAccess,
      request,
    };
  }

  it('parses only one bearer credential', () => {
    expect(merchantApiKeyGuardInternals.extractBearerCredential('Bearer key')).toBe('key');
    expect(merchantApiKeyGuardInternals.extractBearerCredential('bearer   key')).toBe('key');
    expect(merchantApiKeyGuardInternals.extractBearerCredential('Basic key')).toBeUndefined();
    expect(merchantApiKeyGuardInternals.extractBearerCredential(['Bearer key'])).toBeUndefined();
  });

  it('bypasses authentication only for explicit public metadata', async () => {
    const { context, guard, merchantAccess } = createHarness({ isPublic: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(merchantAccess.authenticate.mock.calls).toHaveLength(0);
  });

  it('rejects missing and invalid credentials with the same status', async () => {
    const missing = createHarness({});
    await expect(missing.guard.canActivate(missing.context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const invalid = createHarness({ authorization: 'Bearer wrong' });
    await expect(invalid.guard.canActivate(invalid.context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches non-enumerable identity after successful authentication', async () => {
    const { context, guard, request } = createHarness({
      authenticated: identity,
      authorization: 'Bearer credential',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request[MERCHANT_REQUEST_IDENTITY]).toEqual(identity);
    expect(Object.keys(request)).not.toContain(String(MERCHANT_REQUEST_IDENTITY));
  });

  it('denies a valid key without every required scope', async () => {
    const { context, guard } = createHarness({
      authenticated: identity,
      authorization: 'Bearer credential',
      requiredScopes: ['payments:write'],
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
