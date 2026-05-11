import { describe, expect, it } from 'vitest';

import { loadBootstrap } from '../src/bootstrap';

describe('loadBootstrap', () => {
  it('returns every required value when env is fully populated', () => {
    const result = loadBootstrap({
      HEX_DB_PATH: './data/hexbot.db',
      HEX_PLUGIN_DIR: './plugins',
      HEX_OWNER_HANDLE: 'admin',
      HEX_OWNER_HOSTMASK: '*!*@*',
    });
    expect(result).toEqual({
      dbPath: './data/hexbot.db',
      pluginDir: './plugins',
      ownerHandle: 'admin',
      ownerHostmask: '*!*@*',
      failOnPluginLoadFailure: false,
    });
  });

  it('reads HEX_FAIL_ON_PLUGIN_LOAD_FAILURE as a permissive bool', () => {
    const base = {
      HEX_DB_PATH: './data/hexbot.db',
      HEX_PLUGIN_DIR: './plugins',
      HEX_OWNER_HANDLE: 'admin',
      HEX_OWNER_HOSTMASK: '*!*@*',
    };
    expect(
      loadBootstrap({ ...base, HEX_FAIL_ON_PLUGIN_LOAD_FAILURE: '1' }).failOnPluginLoadFailure,
    ).toBe(true);
    expect(
      loadBootstrap({ ...base, HEX_FAIL_ON_PLUGIN_LOAD_FAILURE: 'true' }).failOnPluginLoadFailure,
    ).toBe(true);
    expect(
      loadBootstrap({ ...base, HEX_FAIL_ON_PLUGIN_LOAD_FAILURE: 'YES' }).failOnPluginLoadFailure,
    ).toBe(true);
    expect(
      loadBootstrap({ ...base, HEX_FAIL_ON_PLUGIN_LOAD_FAILURE: '0' }).failOnPluginLoadFailure,
    ).toBe(false);
    expect(
      loadBootstrap({ ...base, HEX_FAIL_ON_PLUGIN_LOAD_FAILURE: '' }).failOnPluginLoadFailure,
    ).toBe(false);
    expect(loadBootstrap(base).failOnPluginLoadFailure).toBe(false);
  });

  it('throws naming the missing var when HEX_DB_PATH is unset', () => {
    expect(() =>
      loadBootstrap({
        HEX_PLUGIN_DIR: './plugins',
        HEX_OWNER_HANDLE: 'admin',
        HEX_OWNER_HOSTMASK: '*!*@*',
      }),
    ).toThrow(/HEX_DB_PATH is required but unset/);
  });

  it('throws naming the missing var when HEX_PLUGIN_DIR is unset', () => {
    expect(() =>
      loadBootstrap({
        HEX_DB_PATH: 'a',
        HEX_OWNER_HANDLE: 'admin',
        HEX_OWNER_HOSTMASK: '*!*@*',
      }),
    ).toThrow(/HEX_PLUGIN_DIR is required but unset/);
  });

  it('throws naming the missing var when HEX_OWNER_HANDLE is unset', () => {
    expect(() =>
      loadBootstrap({
        HEX_DB_PATH: 'a',
        HEX_PLUGIN_DIR: './plugins',
        HEX_OWNER_HOSTMASK: '*!*@*',
      }),
    ).toThrow(/HEX_OWNER_HANDLE is required but unset/);
  });

  it('throws naming the missing var when HEX_OWNER_HOSTMASK is unset', () => {
    expect(() =>
      loadBootstrap({
        HEX_DB_PATH: 'a',
        HEX_PLUGIN_DIR: './plugins',
        HEX_OWNER_HANDLE: 'admin',
      }),
    ).toThrow(/HEX_OWNER_HOSTMASK is required but unset/);
  });

  it('treats an empty string as unset', () => {
    expect(() =>
      loadBootstrap({
        HEX_DB_PATH: '',
        HEX_PLUGIN_DIR: './plugins',
        HEX_OWNER_HANDLE: 'admin',
        HEX_OWNER_HOSTMASK: '*!*@*',
      }),
    ).toThrow(/HEX_DB_PATH is required but unset/);
  });
});
