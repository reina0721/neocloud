import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendDestination, backendRequestHeaders } from './backend-proxy';

afterEach(() => vi.unstubAllEnvs());

describe('runtime backend routing', () => {
  it('reads the deployment upstream without rebuilding or changing the requested resource', () => {
    vi.stubEnv('NEOCLOUD_BACKEND_URL', 'http://backend:8120');
    expect(backendDestination('https://files.example/api/files/a%2Fb?download=1').href).toBe(
      'http://backend:8120/api/files/a%2Fb?download=1',
    );
    vi.stubEnv('NEOCLOUD_BACKEND_URL', 'https://another-backend.example');
    expect(backendDestination('https://files.example/wopi/files/id?access_token=test').href).toBe(
      'https://another-backend.example/wopi/files/id?access_token=test',
    );
  });

  it('keeps the upstream fixed when a path resembles a protocol-relative URL', () => {
    expect(
      backendDestination('https://files.example//other.example/api', 'http://backend:8080').href,
    ).toBe('http://backend:8080//other.example/api');
  });

  it.each([
    '',
    'backend:8080',
    'file:///etc/passwd',
    'http://user:secret@backend',
    'http://backend/api',
    'http://backend/?target=other',
    'http://backend/#other',
  ])(
    'rejects an ambiguous or invalid upstream without including secrets in the error',
    (backend) => {
      expect(() => backendDestination('https://files.example/api', backend)).toThrow(
        'NEOCLOUD_BACKEND_URL must be an HTTP(S) origin.',
      );
    },
  );
});

describe('browser authority boundary', () => {
  const destination = new URL('http://backend:8080/api/test');
  const request = (
    values: Record<string, string>,
    url = 'http://192.0.2.10:4173/api/test',
    allowed = '[]',
  ) =>
    backendRequestHeaders(
      url,
      new Headers({ host: '192.0.2.10:4173', ...values }),
      destination,
      allowed,
    );

  it('normalizes verified browser origins without losing credentials or CSRF', () => {
    const result = request({
      origin: 'http://192.0.2.10:4173',
      cookie: 'session=kept',
      'x-csrf-token': 'kept',
      'x-neocloud-web-origin': 'https://evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(result.get('origin')).toBe(destination.origin);
    expect(result.get('cookie')).toBe('session=kept');
    expect(result.get('x-csrf-token')).toBe('kept');
    expect(result.get('x-neocloud-web-origin')).toBe('http://192.0.2.10:4173');
    expect(result.has('x-forwarded-host')).toBe(false);
    expect(result.has('x-forwarded-proto')).toBe(false);
  });

  it('does not invent an Origin when the caller omitted it', () => {
    expect(request({}).has('origin')).toBe(false);
  });

  it.each([
    'https://evil.example',
    'null',
    'http://192.0.2.10:4173/path',
    'http://user:secret@192.0.2.10:4173',
    'http://192.0.2.10:4173/',
  ])('rejects unapproved or ambiguous Origin %s', (origin) => {
    expect(() => request({ origin, 'x-forwarded-host': 'evil.example' })).toThrow();
  });

  it.each(['evil.example/path', 'user@evil.example', 'a,b', 'a b', 'a\\b', 'a?b', 'a#b', ''])(
    'rejects invalid Host %s',
    (host) => {
      expect(() => request({ host })).toThrow();
    },
  );

  it('preserves explicit cross-origin configuration and delegates WOPI to its token protocol', () => {
    expect(
      request({ origin: 'https://other.example' }, undefined, '["https://other.example"]').get(
        'origin',
      ),
    ).toBe('https://other.example');
    expect(
      request({ origin: 'https://office.example' }, 'http://192.0.2.10:4173/wopi/files/id').get(
        'origin',
      ),
    ).toBe('https://office.example');
  });

  it('supports HTTPS and default ports without using client headers for policy', () => {
    const result = request(
      { host: 'drive.example:443', origin: 'https://drive.example' },
      'https://drive.example/api/test',
    );
    expect(result.get('origin')).toBe(destination.origin);
  });

  it('normalizes same-authority DAV destinations while leaving foreign targets for backend rejection', () => {
    expect(
      request(
        { destination: 'http://192.0.2.10:4173/dav/a/b%20c' },
        'http://192.0.2.10:4173/dav/a',
      ).get('destination'),
    ).toBe('http://backend:8080/dav/a/b%20c');
    expect(
      request({ destination: 'https://evil.example/dav/a' }, 'http://192.0.2.10:4173/dav/a').get(
        'destination',
      ),
    ).toBe('https://evil.example/dav/a');
  });
});
