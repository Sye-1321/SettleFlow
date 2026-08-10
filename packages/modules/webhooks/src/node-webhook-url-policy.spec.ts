import {
  InvalidWebhookEndpointRequestError,
  WebhookEndpointUrlProhibitedError,
  WebhookEndpointUrlResolutionUnavailableError,
  WebhookEndpointUrlUnresolvableError,
} from './webhook.errors';
import {
  NodeWebhookUrlPolicy,
  nodeWebhookUrlPolicyInternals,
  type WebhookDnsResolver,
} from './node-webhook-url-policy';

function resolver(
  ipv4: readonly string[] | Error,
  ipv6: readonly string[] | Error = Object.assign(new Error('no data'), { code: 'ENODATA' }),
): WebhookDnsResolver {
  return {
    cancel: jest.fn(),
    resolve4: jest.fn(() => (ipv4 instanceof Error ? Promise.reject(ipv4) : Promise.resolve(ipv4))),
    resolve6: jest.fn(() => (ipv6 instanceof Error ? Promise.reject(ipv6) : Promise.resolve(ipv6))),
  };
}

describe('NodeWebhookUrlPolicy', () => {
  it('canonicalizes a production HTTPS URL and validates every DNS family', async (): Promise<void> => {
    const dns = resolver(['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']);
    const policy = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => dns,
    });

    await expect(policy.normalizeAndValidate('https://EXAMPLE.COM.:443?Token=AbC')).resolves.toBe(
      'https://example.com/?Token=AbC',
    );
    // The resolver methods are Jest functions; taking their references is intentional for call assertions.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(dns.resolve4).toHaveBeenCalledWith('example.com');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(dns.resolve6).toHaveBeenCalledWith('example.com');
  });

  it('re-resolves a canonical URL for every delivery and returns one pinned approved address', async () => {
    const first = resolver(['93.184.216.34']);
    const second = resolver(['8.8.8.8']);
    const resolvers = [first, second];
    const policy = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolvers.shift() ?? second,
    });

    await expect(policy.resolveForDelivery('https://example.com/hook')).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
      hostname: 'example.com',
      url: 'https://example.com/hook',
    });
    await expect(policy.resolveForDelivery('https://example.com/hook')).resolves.toMatchObject({
      address: '8.8.8.8',
    });
  });

  it.each([
    ['private IPv4 literal', 'https://10.0.0.1/hook'],
    ['IPv4-mapped loopback literal', 'https://[::ffff:127.0.0.1]/hook'],
    ['loopback IPv6 literal', 'https://[::1]/hook'],
    ['metadata address', 'https://169.254.169.254/latest'],
    ['production HTTP', 'http://93.184.216.34/hook'],
    ['production nonstandard port', 'https://93.184.216.34:8443/hook'],
  ])('rejects %s without exposing an address', async (_name, url): Promise<void> => {
    const policy = new NodeWebhookUrlPolicy({ developmentAllowedOrigins: [], mode: 'production' });
    await expect(policy.normalizeAndValidate(url)).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );
  });

  it('rejects a hostname when any answer is prohibited or the answer cap is exceeded', async (): Promise<void> => {
    const mixed = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(['93.184.216.34', '127.0.0.1']),
    });
    await expect(mixed.normalizeAndValidate('https://example.com/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );

    const tooMany = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      maxAnswers: 1,
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(['93.184.216.34', '8.8.8.8']),
    });
    await expect(tooMany.normalizeAndValidate('https://example.com/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );

    const mappedPrivate = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(['::ffff:10.0.0.1']),
    });
    await expect(
      mappedPrivate.normalizeAndValidate('https://example.com/mapped'),
    ).rejects.toBeInstanceOf(WebhookEndpointUrlProhibitedError);
  });

  it('permits only an exact injected development origin for local HTTP', async (): Promise<void> => {
    const policy = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: ['http://127.0.0.1:8080'],
      mode: 'development',
    });
    await expect(policy.normalizeAndValidate('http://127.0.0.1:8080/hook')).resolves.toBe(
      'http://127.0.0.1:8080/hook',
    );
    await expect(policy.normalizeAndValidate('http://127.0.0.1:8081/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );
  });

  it('distinguishes stable no-data from transient DNS failure and cancels on timeout', async (): Promise<void> => {
    const noData = Object.assign(new Error('no data'), { code: 'ENODATA' });
    const unresolvable = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(noData, noData),
    });
    await expect(
      unresolvable.normalizeAndValidate('https://does-not-exist.example/hook'),
    ).rejects.toBeInstanceOf(WebhookEndpointUrlUnresolvableError);

    const temporary = Object.assign(new Error('temporary'), { code: 'ESERVFAIL' });
    const unavailable = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(['93.184.216.34'], temporary),
    });
    await expect(
      unavailable.normalizeAndValidate('https://example.com/hook'),
    ).rejects.toBeInstanceOf(WebhookEndpointUrlResolutionUnavailableError);

    const cancel = jest.fn();
    const never = new Promise<readonly string[]>((): void => undefined);
    const timedOut = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => ({
        cancel,
        resolve4: (): Promise<readonly string[]> => never,
        resolve6: (): Promise<readonly string[]> => never,
      }),
      timeoutMs: 5,
    });
    await expect(timedOut.normalizeAndValidate('https://example.com/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlResolutionUnavailableError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['', InvalidWebhookEndpointRequestError],
    ['x'.repeat(2_049), InvalidWebhookEndpointRequestError],
    ['https://example.com/\u0001', InvalidWebhookEndpointRequestError],
    ['https://example.com/\ud800', InvalidWebhookEndpointRequestError],
    ['https://example.com/#fragment', InvalidWebhookEndpointRequestError],
    ['not a URL', InvalidWebhookEndpointRequestError],
    ['ftp://example.com/hook', WebhookEndpointUrlProhibitedError],
    ['https://user:password@example.com/hook', WebhookEndpointUrlProhibitedError],
  ])('rejects malformed or prohibited URL %p', async (url, errorType): Promise<void> => {
    const policy = new NodeWebhookUrlPolicy({ developmentAllowedOrigins: [], mode: 'production' });
    await expect(policy.normalizeAndValidate(url)).rejects.toBeInstanceOf(errorType);
  });

  it('validates configuration origins and prohibits development exceptions in production', () => {
    expect(
      () =>
        new NodeWebhookUrlPolicy({
          developmentAllowedOrigins: ['not an origin'],
          mode: 'development',
        }),
    ).toThrow('invalid origin');
    expect(
      () =>
        new NodeWebhookUrlPolicy({
          developmentAllowedOrigins: ['http://127.0.0.1:8080/'],
          mode: 'development',
        }),
    ).toThrow('canonical origins');
    expect(
      () =>
        new NodeWebhookUrlPolicy({
          developmentAllowedOrigins: ['http://127.0.0.1:8080'],
          mode: 'production',
        }),
    ).toThrow('cannot be configured in production');
  });

  it('rejects noncanonical delivery URLs and malformed DNS answers', async () => {
    const global = resolver(['93.184.216.34', '93.184.216.34']);
    const policy = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => global,
    });
    await expect(policy.resolveForDelivery('https://EXAMPLE.COM/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );
    await expect(policy.normalizeAndValidate('https://example.com/hook')).resolves.toBe(
      'https://example.com/hook',
    );

    const malformed = new NodeWebhookUrlPolicy({
      developmentAllowedOrigins: [],
      mode: 'production',
      resolverFactory: (): WebhookDnsResolver => resolver(['not-an-ip']),
    });
    await expect(malformed.normalizeAndValidate('https://example.com/hook')).rejects.toBeInstanceOf(
      WebhookEndpointUrlProhibitedError,
    );
  });

  it('covers the explicit address and normalization security predicates', () => {
    expect(nodeWebhookUrlPolicyInternals.hostnameWithoutBrackets('[::1]')).toBe('::1');
    expect(nodeWebhookUrlPolicyInternals.hostnameWithoutBrackets('example.com')).toBe(
      'example.com',
    );
    expect(nodeWebhookUrlPolicyInternals.hasControlCharacters('safe')).toBe(false);
    expect(nodeWebhookUrlPolicyInternals.hasControlCharacters('bad\u007f')).toBe(true);
    expect(nodeWebhookUrlPolicyInternals.isProhibitedAddress('127.0.0.1')).toBe(true);
    expect(nodeWebhookUrlPolicyInternals.isProhibitedAddress('::1')).toBe(true);
    expect(nodeWebhookUrlPolicyInternals.isProhibitedAddress('93.184.216.34')).toBe(false);
    expect(nodeWebhookUrlPolicyInternals.isProhibitedAddress('invalid')).toBe(true);
    expect(nodeWebhookUrlPolicyInternals.normalize('https://EXAMPLE.COM./').href).toBe(
      'https://example.com/',
    );
  });
});
