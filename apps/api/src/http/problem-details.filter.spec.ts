import { HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { problemDetailsInternals } from './problem-details.filter';

describe('problem-details mapping', () => {
  it('maps unknown exception text to a generic non-leaking 500', () => {
    const problem = problemDetailsInternals.descriptor(
      new Error('password=secret SELECT * FROM payment_intents'),
    );
    expect(problem).toEqual({
      code: 'internal_error',
      detail: 'An unexpected error occurred.',
      status: 500,
      title: 'Internal error',
    });
    expect(JSON.stringify(problem)).not.toContain('secret');
    expect(JSON.stringify(problem)).not.toContain('SELECT');
  });

  it('maps structural database outage and retry-exhaustion codes to safe 503s', () => {
    for (const error of [
      { cause: { code: 'P1001' } },
      { cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] } },
      { meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } },
      { code: 'P2028' },
      new ServiceUnavailableException(),
    ]) {
      expect(problemDetailsInternals.descriptor(error)).toMatchObject({
        code: 'service_unavailable',
        status: 503,
      });
    }
  });

  it('does not expose arbitrary framework exception response bodies', () => {
    expect(
      problemDetailsInternals.descriptor(
        new HttpException({ databaseUrl: 'postgresql://secret', message: 'unsafe' }, 400),
      ),
    ).toEqual({
      code: 'invalid_request',
      detail: 'The request is invalid.',
      status: 400,
      title: 'Invalid request',
    });
  });

  it('keeps unmatched routes as RFC-compatible 404s', () => {
    expect(problemDetailsInternals.descriptor(new NotFoundException())).toEqual({
      code: 'route_not_found',
      detail: 'The requested route was not found.',
      status: 404,
      title: 'Route not found',
    });
  });
});
