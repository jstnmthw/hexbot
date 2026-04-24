import { describe, expect, it } from 'vitest';

import type { ProxyConfig } from '../src/types';
import { buildSocksOptions } from '../src/utils/socks';

describe('buildSocksOptions', () => {
  it('produces host and port without auth fields when credentials are omitted', () => {
    const proxy: ProxyConfig = { enabled: true, host: '127.0.0.1', port: 9050 };
    const opts = buildSocksOptions(proxy);

    expect(opts).toEqual({ host: '127.0.0.1', port: 9050 });
    expect('user' in opts).toBe(false);
    expect('pass' in opts).toBe(false);
  });

  it('includes user and pass when credentials are provided', () => {
    const proxy: ProxyConfig = {
      enabled: true,
      host: 'proxy.example.com',
      port: 1080,
      username: 'alice',
      password: 's3cret',
    };
    const opts = buildSocksOptions(proxy);

    expect(opts).toEqual({ host: 'proxy.example.com', port: 1080, user: 'alice', pass: 's3cret' });
  });

  it('omits both user and pass when only username is provided (no password)', () => {
    const proxy: ProxyConfig = { enabled: true, host: '127.0.0.1', port: 1080, username: 'bob' };
    const opts = buildSocksOptions(proxy);

    expect('user' in opts).toBe(false);
    expect('pass' in opts).toBe(false);
  });

  it('omits both user and pass when only password is provided (no username)', () => {
    const proxy: ProxyConfig = {
      enabled: true,
      host: '127.0.0.1',
      port: 1080,
      password: 'only-pass',
    };
    const opts = buildSocksOptions(proxy);

    expect('user' in opts).toBe(false);
    expect('pass' in opts).toBe(false);
  });

  it('does not include credential keys with undefined values', () => {
    const proxy: ProxyConfig = { enabled: true, host: '10.0.0.1', port: 9050 };
    const opts = buildSocksOptions(proxy);

    // Ensure the spread didn't add keys with undefined values
    for (const val of Object.values(opts)) {
      expect(val).not.toBeUndefined();
    }
  });
});
