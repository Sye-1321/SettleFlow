import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { MerchantApiKeyScope, MerchantRequestIdentity } from '@settleflow/merchant-access';

import { MERCHANT_REQUEST_IDENTITY, type MerchantAuthenticatedRequest } from './merchant-request';

export const PUBLIC_ROUTE_METADATA = 'settleflow.public-route';
export const REQUIRED_MERCHANT_SCOPES_METADATA = 'settleflow.required-merchant-scopes';

export function PublicRoute(): ClassDecorator & MethodDecorator {
  return SetMetadata(PUBLIC_ROUTE_METADATA, true);
}

export function RequireMerchantScopes(
  ...scopes: readonly MerchantApiKeyScope[]
): ClassDecorator & MethodDecorator {
  return SetMetadata(REQUIRED_MERCHANT_SCOPES_METADATA, scopes);
}

export const MerchantIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MerchantRequestIdentity => {
    const request = context.switchToHttp().getRequest<MerchantAuthenticatedRequest>();
    const identity = request[MERCHANT_REQUEST_IDENTITY];
    if (identity === undefined) {
      throw new Error('Merchant identity is unavailable; the authentication guard must run first');
    }

    return identity;
  },
);
