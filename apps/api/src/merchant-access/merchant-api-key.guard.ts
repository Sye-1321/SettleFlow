import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MerchantAccessService, type MerchantApiKeyScope } from '@settleflow/merchant-access';
import { TelemetryRuntime } from '@settleflow/infrastructure';

import {
  PUBLIC_ROUTE_METADATA,
  REQUIRED_MERCHANT_SCOPES_METADATA,
} from './merchant-access.decorators';
import { MERCHANT_REQUEST_IDENTITY, type MerchantAuthenticatedRequest } from './merchant-request';

function extractBearerCredential(
  authorization: string | readonly string[] | undefined,
): string | undefined {
  if (typeof authorization !== 'string') {
    return undefined;
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return parts[1];
}

@Injectable()
export class MerchantApiKeyGuard implements CanActivate {
  public constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly reflector: Reflector,
    private readonly telemetry: TelemetryRuntime,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<MerchantAuthenticatedRequest>();
    const credential = extractBearerCredential(request.headers.authorization);
    if (credential === undefined) {
      throw new UnauthorizedException();
    }

    const identity = await this.telemetry.span(
      'merchant.authenticate',
      { operation: 'merchant.authenticate' },
      () => this.merchantAccess.authenticate(credential),
    );
    if (identity === undefined) {
      throw new UnauthorizedException();
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<readonly MerchantApiKeyScope[]>(
        REQUIRED_MERCHANT_SCOPES_METADATA,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    if (!this.merchantAccess.hasScopes(identity, requiredScopes)) {
      throw new ForbiddenException();
    }

    Object.defineProperty(request, MERCHANT_REQUEST_IDENTITY, {
      configurable: false,
      enumerable: false,
      value: identity,
      writable: false,
    });
    this.telemetry.context.enrich({ merchantId: identity.merchantId });
    return true;
  }
}

export const merchantApiKeyGuardInternals = {
  extractBearerCredential,
};
