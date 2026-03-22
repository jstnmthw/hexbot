import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Permissions } from '../../src/core/permissions.js';
import { EventDispatcher } from '../../src/dispatcher.js';
import type { HandlerContext } from '../../src/types.js';

/** Helper: create a minimal HandlerContext for testing. */
function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'testuser',
    ident: 'user',
    hostname: 'test.host.com',
    channel: '#test',
    text: '',
    command: '',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

describe('Dispatcher + Permissions integration', () => {
  let perms: Permissions;
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    perms = new Permissions();
    dispatcher = new EventDispatcher(perms);

    // Add a user with op flag
    perms.addUser('oper', '*!oper@trusted.host', 'o', 'test');
    // Add a user with no flags
    perms.addUser('regular', '*!regular@some.host', '', 'test');
  });

  it('should fire handler when user has required +o flag', async () => {
    const handler = vi.fn();
    dispatcher.bind('pub', '+o', '!opcmd', handler, 'test-plugin');

    const ctx = makeCtx({
      nick: 'oper',
      ident: 'oper',
      hostname: 'trusted.host',
      command: '!opcmd',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test-plugin');
  });

  it('should NOT fire handler when user lacks required +o flag', async () => {
    const handler = vi.fn();
    dispatcher.bind('pub', '+o', '!opcmd', handler, 'test-plugin');

    const ctx = makeCtx({
      nick: 'regular',
      ident: 'regular',
      hostname: 'some.host',
      command: '!opcmd',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(handler).not.toHaveBeenCalled();
    dispatcher.unbindAll('test-plugin');
  });

  it('should fire handler for unknown user with - flags', async () => {
    const handler = vi.fn();
    dispatcher.bind('pub', '-', '!public', handler, 'test-plugin');

    const ctx = makeCtx({
      nick: 'stranger',
      ident: 'x',
      hostname: 'unknown.host',
      command: '!public',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test-plugin');
  });

  it('should NOT fire handler for unknown user with +o requirement', async () => {
    const handler = vi.fn();
    dispatcher.bind('pub', '+o', '!secret', handler, 'test-plugin');

    const ctx = makeCtx({
      nick: 'stranger',
      ident: 'x',
      hostname: 'unknown.host',
      command: '!secret',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(handler).not.toHaveBeenCalled();
    dispatcher.unbindAll('test-plugin');
  });

  it('should respect owner flag implying all other flags', async () => {
    perms.addUser('owner', '*!owner@secure.host', 'n', 'test');

    const handler = vi.fn();
    dispatcher.bind('pub', '+o', '!opcmd', handler, 'test-plugin');

    const ctx = makeCtx({
      nick: 'owner',
      ident: 'owner',
      hostname: 'secure.host',
      command: '!opcmd',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test-plugin');
  });

  it('should respect per-channel flags', async () => {
    perms.addUser('chanop', '*!chanop@host', '', 'test');
    perms.setChannelFlags('chanop', '#allowed', 'o', 'test');

    const handler = vi.fn();
    dispatcher.bind('pub', '+o', '!opcmd', handler, 'test-plugin');

    // Should work in #allowed
    const ctxAllowed = makeCtx({
      nick: 'chanop',
      ident: 'chanop',
      hostname: 'host',
      channel: '#allowed',
      command: '!opcmd',
    });
    await dispatcher.dispatch('pub', ctxAllowed);
    expect(handler).toHaveBeenCalledOnce();

    // Should NOT work in #denied
    handler.mockClear();
    const ctxDenied = makeCtx({
      nick: 'chanop',
      ident: 'chanop',
      hostname: 'host',
      channel: '#denied',
      command: '!opcmd',
    });
    await dispatcher.dispatch('pub', ctxDenied);
    expect(handler).not.toHaveBeenCalled();

    dispatcher.unbindAll('test-plugin');
  });
});
