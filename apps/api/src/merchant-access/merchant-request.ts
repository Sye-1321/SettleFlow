import type { MerchantRequestIdentity } from '@settleflow/merchant-access';

export const MERCHANT_REQUEST_IDENTITY = Symbol('settleflow.merchant-request-identity');

export interface MerchantAuthenticatedRequest {
  readonly headers: {
    readonly authorization?: string | readonly string[];
  };
  [MERCHANT_REQUEST_IDENTITY]?: MerchantRequestIdentity;
}
