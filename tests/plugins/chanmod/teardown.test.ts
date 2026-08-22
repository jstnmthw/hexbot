// chanmod — teardown() fault tolerance.
//
// The loader reuses the cached ESM module across reloads, so a teardown
// callback that throws must not strand the callbacks registered after it
// (timer clears, clearSharedState) or leave the module-level `teardowns`
// array holding closures over the disposed plugin graph.
//
// Two setup* helpers are mocked: `setupInvite` returns a throwing teardown,
// `setupStickyBans` (registered after it) returns a recording one.
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { teardown as chanmodTeardown } from '../../../plugins/chanmod/index';
import { makeChanmodPluginOverrides } from '../../helpers/chanmod-plugin-config';
import { type MockBot, createMockBot } from '../../helpers/mock-bot';
import { flush } from '../../helpers/plugin-test-helpers';

const counters = vi.hoisted(() => ({ invite: 0, sticky: 0 }));

vi.mock('../../../plugins/chanmod/invite', () => ({
  setupInvite: () => () => {
    counters.invite++;
    throw new Error('invite teardown boom');
  },
}));

vi.mock('../../../plugins/chanmod/sticky', () => ({
  setupStickyBans: () => () => {
    counters.sticky++;
  },
}));

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

describe('chanmod teardown() — throwing callbacks', () => {
  let bot: MockBot;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    counters.invite = 0;
    counters.sticky = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bot = createMockBot({ botNick: 'hexbot' });
    await bot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
    await flush();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    bot.cleanup();
  });

  it('runs the remaining teardowns and clears the registry after a throw', async () => {
    await expect(bot.pluginLoader.unload('chanmod')).resolves.toBeUndefined();

    expect(counters.invite).toBe(1);
    // Registered after the throwing callback — proof the loop continued.
    expect(counters.sticky).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('[chanmod] teardown callback threw:', expect.any(Error));

    // `teardowns = []` ran in the finally, so a second teardown is a no-op
    // instead of re-running stale closures against disposed state.
    chanmodTeardown();
    expect(counters.invite).toBe(1);
    expect(counters.sticky).toBe(1);
  });
});
