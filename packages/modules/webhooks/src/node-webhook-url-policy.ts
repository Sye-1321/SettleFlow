import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { PROHIBITED_IPV4_SUBNETS, PROHIBITED_IPV6_SUBNETS } from './iana-special-purpose-addresses';
import {
  InvalidWebhookEndpointRequestError,
  WebhookEndpointUrlProhibitedError,
  WebhookEndpointUrlResolutionUnavailableError,
  WebhookEndpointUrlUnresolvableError,
} from './webhook.errors';
import type { WebhookUrlPolicy } from './webhook.types';
import type {
  ResolvedWebhookDestination,
  WebhookDeliveryUrlPolicy,
} from './webhook-delivery.types';

export interface WebhookDnsResolver {
  cancel(): void;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

export interface NodeWebhookUrlPolicyOptions {
  readonly developmentAllowedOrigins: readonly string[];
  readonly maxAnswers?: number;
  readonly mode: 'development' | 'production';
  readonly resolverFactory?: () => WebhookDnsResolver;
  readonly timeoutMs?: number;
}

const prohibitedAddresses = new BlockList();
for (const [network, prefix] of PROHIBITED_IPV4_SUBNETS) {
  prohibitedAddresses.addSubnet(network, prefix, 'ipv4');
  prohibitedAddresses.addSubnet(`::ffff:${network}`, 96 + prefix, 'ipv6');
}
for (const [network, prefix] of PROHIBITED_IPV6_SUBNETS) {
  prohibitedAddresses.addSubnet(network, prefix, 'ipv6');
}

const NO_DATA_CODES = new Set(['ENODATA', 'ENOTFOUND', 'EAI_NONAME']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)['code'];
  return typeof value === 'string' ? value : undefined;
}

async function resolveFamily(operation: Promise<readonly string[]>): Promise<readonly string[]> {
  try {
    return await operation;
  } catch (error: unknown) {
    if (NO_DATA_CODES.has(errorCode(error) ?? '')) {
      return [];
    }
    throw new WebhookEndpointUrlResolutionUnavailableError();
  }
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function assertCanonicalDevelopmentOrigins(origins: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS contains an invalid origin');
    }
    if (
      parsed.origin !== origin ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
      throw new Error('WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS must contain canonical origins only');
    }
    result.add(origin);
  }
  return result;
}

function normalize(rawUrl: string): URL {
  if (
    Buffer.byteLength(rawUrl, 'utf8') < 1 ||
    Buffer.byteLength(rawUrl, 'utf8') > 2_048 ||
    hasControlCharacters(rawUrl) ||
    /[\uD800-\uDFFF]/u.test(rawUrl) ||
    rawUrl.includes('#')
  ) {
    throw new InvalidWebhookEndpointRequestError('url');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidWebhookEndpointRequestError('url');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  ) {
    throw new WebhookEndpointUrlProhibitedError();
  }

  if (parsed.hostname.endsWith('.')) {
    parsed.hostname = parsed.hostname.slice(0, -1);
  }
  if (parsed.pathname === '') {
    parsed.pathname = '/';
  }
  if (Buffer.byteLength(parsed.href, 'utf8') > 2_048) {
    throw new InvalidWebhookEndpointRequestError('url');
  }
  return parsed;
}

function isProhibitedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return prohibitedAddresses.check(address, 'ipv4');
  }
  if (family === 6) {
    return prohibitedAddresses.check(address, 'ipv6');
  }
  return true;
}

export class NodeWebhookUrlPolicy implements WebhookDeliveryUrlPolicy, WebhookUrlPolicy {
  private readonly allowedDevelopmentOrigins: ReadonlySet<string>;
  private readonly maxAnswers: number;
  private readonly mode: 'development' | 'production';
  private readonly resolverFactory: () => WebhookDnsResolver;
  private readonly timeoutMs: number;

  public constructor(options: NodeWebhookUrlPolicyOptions) {
    this.allowedDevelopmentOrigins = assertCanonicalDevelopmentOrigins(
      options.developmentAllowedOrigins,
    );
    this.maxAnswers = options.maxAnswers ?? 16;
    this.mode = options.mode;
    this.resolverFactory = options.resolverFactory ?? ((): WebhookDnsResolver => new Resolver());
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (this.mode === 'production' && this.allowedDevelopmentOrigins.size > 0) {
      throw new Error('Development webhook origins cannot be configured in production');
    }
  }

  public async normalizeAndValidate(rawUrl: string): Promise<string> {
    const parsed = normalize(rawUrl);
    await this.resolveAndValidate(parsed);
    return parsed.href;
  }

  public async resolveForDelivery(normalizedUrl: string): Promise<ResolvedWebhookDestination> {
    const parsed = normalize(normalizedUrl);
    if (parsed.href !== normalizedUrl) {
      throw new WebhookEndpointUrlProhibitedError();
    }
    const addresses = await this.resolveAndValidate(parsed);
    const selected = addresses[0];
    if (selected === undefined) {
      throw new WebhookEndpointUrlUnresolvableError();
    }
    const family = isIP(selected);
    if (family !== 4 && family !== 6) {
      throw new WebhookEndpointUrlProhibitedError();
    }
    return {
      address: selected,
      family,
      hostname: hostnameWithoutBrackets(parsed.hostname),
      url: parsed.href,
    };
  }

  private async resolveAndValidate(parsed: URL): Promise<readonly string[]> {
    const developmentException =
      this.mode === 'development' && this.allowedDevelopmentOrigins.has(parsed.origin);
    if (!developmentException && (parsed.protocol !== 'https:' || parsed.port !== '')) {
      throw new WebhookEndpointUrlProhibitedError();
    }

    const hostname = hostnameWithoutBrackets(parsed.hostname);
    const addresses = isIP(hostname) === 0 ? await this.resolve(hostname) : [hostname];
    if (addresses.length === 0) {
      throw new WebhookEndpointUrlUnresolvableError();
    }
    const distinct = [...new Set(addresses)];
    if (distinct.length > this.maxAnswers) {
      throw new WebhookEndpointUrlProhibitedError();
    }
    if (!developmentException && distinct.some((address) => isProhibitedAddress(address))) {
      throw new WebhookEndpointUrlProhibitedError();
    }
    if (distinct.some((address) => isIP(address) === 0)) {
      throw new WebhookEndpointUrlProhibitedError();
    }

    return distinct;
  }

  private async resolve(hostname: string): Promise<readonly string[]> {
    const resolver = this.resolverFactory();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        resolver.cancel();
        reject(new WebhookEndpointUrlResolutionUnavailableError());
      }, this.timeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([
        Promise.all([
          resolveFamily(resolver.resolve4(hostname)),
          resolveFamily(resolver.resolve6(hostname)),
        ]).then(([ipv4, ipv6]) => [...ipv4, ...ipv6]),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

export const nodeWebhookUrlPolicyInternals = {
  assertCanonicalDevelopmentOrigins,
  hasControlCharacters,
  hostnameWithoutBrackets,
  isProhibitedAddress,
  normalize,
};
