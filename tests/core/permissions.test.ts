import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import { createLogger } from '../../src/logger';

describe('Permissions', () => {
  let perms: Permissions;

  beforeEach(() => {
    perms = new Permissions();
  });

  // -------------------------------------------------------------------------
  // addUser / getUser
  // -------------------------------------------------------------------------

  describe('addUser / getUser', () => {
    it('should add and retrieve a user', () => {
      perms.addUser('admin', '*!myident@my.host.com', 'nmov', 'REPL');
      const user = perms.getUser('admin');
      expect(user).not.toBeNull();
      expect(user!.handle).toBe('admin');
      expect(user!.hostmasks).toEqual(['*!myident@my.host.com']);
      expect(user!.global).toBe('nmov');
      expect(user!.channels).toEqual({});
    });

    it('should be case-insensitive on handle lookup', () => {
      perms.addUser('Admin', '*!test@host', 'o', 'REPL');
      expect(perms.getUser('admin')).not.toBeNull();
      expect(perms.getUser('ADMIN')).not.toBeNull();
    });

    it('should throw when adding a duplicate handle', () => {
      perms.addUser('admin', '*!test@host', 'n', 'REPL');
      expect(() => perms.addUser('admin', '*!other@host', 'o', 'REPL')).toThrow('already exists');
    });

    it('should return null for unknown handle', () => {
      expect(perms.getUser('nobody')).toBeNull();
    });

    it('should normalize flags (deduplicate, canonical order)', () => {
      perms.addUser('test', '*!t@h', 'voon', 'REPL');
      expect(perms.getUser('test')!.global).toBe('nov');
    });

    it('should accept d (deop) flag', () => {
      perms.addUser('deopuser', '*!t@h', 'ovd', 'REPL');
      expect(perms.getUser('deopuser')!.global).toBe('ovd');
    });
  });

  // -------------------------------------------------------------------------
  // removeUser
  // -------------------------------------------------------------------------

  describe('removeUser', () => {
    it('should remove an existing user', () => {
      perms.addUser('admin', '*!t@h', 'n', 'REPL');
      perms.removeUser('admin', 'REPL');
      expect(perms.getUser('admin')).toBeNull();
    });

    it('should throw when removing a nonexistent user', () => {
      expect(() => perms.removeUser('nobody', 'REPL')).toThrow('not found');
    });
  });

  // -------------------------------------------------------------------------
  // addHostmask / removeHostmask
  // -------------------------------------------------------------------------

  describe('addHostmask / removeHostmask', () => {
    beforeEach(() => {
      perms.addUser('admin', '*!ident@host1', 'n', 'REPL');
    });

    it('should add a hostmask to an existing user', () => {
      perms.addHostmask('admin', '*!ident@host2', 'REPL');
      const user = perms.getUser('admin')!;
      expect(user.hostmasks).toEqual(['*!ident@host1', '*!ident@host2']);
    });

    it('should not duplicate an existing hostmask', () => {
      perms.addHostmask('admin', '*!ident@host1', 'REPL');
      expect(perms.getUser('admin')!.hostmasks).toEqual(['*!ident@host1']);
    });

    it('should throw when user not found', () => {
      expect(() => perms.addHostmask('nobody', '*!t@h', 'REPL')).toThrow('not found');
    });

    it('should remove a hostmask', () => {
      perms.addHostmask('admin', '*!ident@host2', 'REPL');
      perms.removeHostmask('admin', '*!ident@host1', 'REPL');
      expect(perms.getUser('admin')!.hostmasks).toEqual(['*!ident@host2']);
    });

    it('should throw when removing a nonexistent hostmask', () => {
      expect(() => perms.removeHostmask('admin', '*!bad@mask', 'REPL')).toThrow(
        'Hostmask "*!bad@mask" not found for user "admin"',
      );
    });

    it('should throw when removing hostmask from nonexistent user', () => {
      expect(() => perms.removeHostmask('nobody', '*!t@h', 'REPL')).toThrow('not found');
    });

    it('addHostmask without source defaults to "unknown"', () => {
      // No error means the ?? 'unknown' fallback path was executed
      expect(() => perms.addHostmask('admin', '*!ident@host3')).not.toThrow();
    });

    it('removeHostmask without source defaults to "unknown"', () => {
      expect(() => perms.removeHostmask('admin', '*!ident@host1')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // checkFlags
  // -------------------------------------------------------------------------

  describe('checkFlags', () => {
    beforeEach(() => {
      perms.addUser('owner', '*!owner@secure.host', 'nmov', 'REPL');
      perms.addUser('oper', '*!oper@some.host', 'o', 'REPL');
      perms.addUser('nobody', '*!nobody@some.host', '', 'REPL');
    });

    function makeCtx(
      overrides: {
        nick?: string;
        ident?: string;
        hostname?: string;
        channel?: string | null;
      } = {},
    ) {
      return {
        nick: overrides.nick ?? 'testuser',
        ident: overrides.ident ?? 'user',
        hostname: overrides.hostname ?? 'test.host.com',
        channel: overrides.channel ?? '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      };
    }

    it('should always pass with "-" (no requirement)', () => {
      const ctx = makeCtx({ nick: 'stranger', ident: 'x', hostname: 'x.x' });
      expect(perms.checkFlags('-', ctx)).toBe(true);
    });

    it('should always pass with "" (empty flags)', () => {
      const ctx = makeCtx();
      expect(perms.checkFlags('', ctx)).toBe(true);
    });

    it('should pass when user has +o flag', () => {
      const ctx = makeCtx({ nick: 'oper', ident: 'oper', hostname: 'some.host' });
      expect(perms.checkFlags('+o', ctx)).toBe(true);
    });

    it('should fail when user lacks the required flag', () => {
      const ctx = makeCtx({ nick: 'oper', ident: 'oper', hostname: 'some.host' });
      expect(perms.checkFlags('+n', ctx)).toBe(false);
    });

    it('should pass for owner — n implies all flags', () => {
      const ctx = makeCtx({ nick: 'owner', ident: 'owner', hostname: 'secure.host' });
      expect(perms.checkFlags('+o', ctx)).toBe(true);
      expect(perms.checkFlags('+m', ctx)).toBe(true);
      expect(perms.checkFlags('+v', ctx)).toBe(true);
      expect(perms.checkFlags('+n', ctx)).toBe(true);
    });

    it('should support OR logic with +n|+m', () => {
      const ctx = makeCtx({ nick: 'oper', ident: 'oper', hostname: 'some.host' });
      // oper has 'o' but not 'n' or 'm'
      expect(perms.checkFlags('+n|+m', ctx)).toBe(false);

      const ownerCtx = makeCtx({ nick: 'owner', ident: 'owner', hostname: 'secure.host' });
      expect(perms.checkFlags('+n|+m', ownerCtx)).toBe(true);
    });

    it('should fail for unrecognized user', () => {
      const ctx = makeCtx({ nick: 'unknown', ident: 'x', hostname: 'x.x' });
      expect(perms.checkFlags('+o', ctx)).toBe(false);
    });

    it('should check per-channel flags', () => {
      perms.setChannelFlags('oper', '#main', 'o', 'REPL');

      // oper has 'o' in #main
      const ctxMain = makeCtx({
        nick: 'oper',
        ident: 'oper',
        hostname: 'some.host',
        channel: '#main',
      });
      expect(perms.checkFlags('+o', ctxMain)).toBe(true);

      // oper has 'o' globally too, so #games should still work via global flags
      const ctxGames = makeCtx({
        nick: 'oper',
        ident: 'oper',
        hostname: 'some.host',
        channel: '#games',
      });
      expect(perms.checkFlags('+o', ctxGames)).toBe(true);
    });

    it('should use channel flags to grant access not in global', () => {
      perms.addUser('chanop', '*!chanop@host', '', 'REPL');
      perms.setChannelFlags('chanop', '#special', 'o', 'REPL');

      // chanop has no global flags, but has 'o' in #special
      const ctx = makeCtx({
        nick: 'chanop',
        ident: 'chanop',
        hostname: 'host',
        channel: '#special',
      });
      expect(perms.checkFlags('+o', ctx)).toBe(true);

      // But not in #other
      const ctxOther = makeCtx({
        nick: 'chanop',
        ident: 'chanop',
        hostname: 'host',
        channel: '#other',
      });
      expect(perms.checkFlags('+o', ctxOther)).toBe(false);
    });

    it('should fall back to global when no channel-specific flags', () => {
      const ctx = makeCtx({
        nick: 'oper',
        ident: 'oper',
        hostname: 'some.host',
        channel: '#anychannel',
      });
      expect(perms.checkFlags('+o', ctx)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // findByHostmask
  // -------------------------------------------------------------------------

  describe('findByHostmask', () => {
    beforeEach(() => {
      perms.addUser('admin', '*!myident@my.host.com', 'n', 'REPL');
      perms.addUser('wilduser', '*!*@wild.host', 'o', 'REPL');
    });

    it('should match exact hostmask', () => {
      const result = perms.findByHostmask('anynick!myident@my.host.com');
      expect(result).not.toBeNull();
      expect(result!.handle).toBe('admin');
    });

    it('should match wildcard patterns (*!*@host)', () => {
      const result = perms.findByHostmask('someone!anyident@wild.host');
      expect(result).not.toBeNull();
      expect(result!.handle).toBe('wilduser');
    });

    it('should match wildcard patterns (*!ident@*)', () => {
      perms.addUser('identuser', '*!specialident@*', 'v', 'REPL');
      const result = perms.findByHostmask('nick!specialident@any.host');
      expect(result).not.toBeNull();
      expect(result!.handle).toBe('identuser');
    });

    it('should return null for non-matching hostmask', () => {
      expect(perms.findByHostmask('nobody!wrong@wrong.host')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Account-pattern matching (§7 Phase 4) — `$a:accountname` in hostmasks
  // -------------------------------------------------------------------------

  describe('findByHostmask with account patterns', () => {
    it('matches $a:accountname when the supplied account equals the pattern', () => {
      perms.addUser('alice', '$a:AliceAcct', 'n', 'REPL');
      const result = perms.findByHostmask('Alice!alice@any.host', 'AliceAcct');
      expect(result?.handle).toBe('alice');
    });

    it('matches $a:accountname case-insensitively via ircLower', () => {
      perms.addUser('alice', '$a:AliceAcct', 'n', 'REPL');
      const result = perms.findByHostmask('Alice!alice@any.host', 'aliceacct');
      expect(result?.handle).toBe('alice');
    });

    it('supports wildcards in account patterns (`$a:alice*`)', () => {
      perms.addUser('alice', '$a:alice*', 'n', 'REPL');
      const matched = perms.findByHostmask('Any!any@any.host', 'alice_bot');
      expect(matched?.handle).toBe('alice');
    });

    it('does not match an account pattern when account is null', () => {
      perms.addUser('alice', '$a:AliceAcct', 'n', 'REPL');
      const result = perms.findByHostmask('Alice!alice@any.host', null);
      expect(result).toBeNull();
    });

    it('does not match an account pattern when account is undefined', () => {
      perms.addUser('alice', '$a:AliceAcct', 'n', 'REPL');
      // No account argument at all — old call sites still work.
      const result = perms.findByHostmask('Alice!alice@any.host');
      expect(result).toBeNull();
    });

    it('falls back to hostmask patterns when account does not match', () => {
      perms.addUser('alice', '$a:OtherAcct', 'n', 'REPL');
      perms.addHostmask('alice', '*!alice@known.host');
      const result = perms.findByHostmask('Alice!alice@known.host', 'WrongAcct');
      expect(result?.handle).toBe('alice');
    });

    it('ignores an empty `$a:` pattern rather than matching everyone', () => {
      perms.addUser('alice', '$a:', 'n', 'REPL');
      const result = perms.findByHostmask('Alice!alice@any.host', 'AliceAcct');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Spoofing regression (§7 Phase 4) — hostmask lookups cannot be faked
  // -------------------------------------------------------------------------

  describe('checkFlags spoofing regression', () => {
    it('denies a user whose nick matches a stored record but whose host does not', () => {
      // Original audit scenario: `alice` has `alice!real@host.com` +o. An
      // attacker adopts the nick `alice` from `pwned!fake@evil.host`. With
      // the old findByNick code that matched on nick alone, the attacker
      // would have been granted +o. findByHostmask must reject them.
      perms.addUser('alice', 'alice!real@host.com', 'o', 'REPL');
      const denied = perms.checkFlags('+o', {
        nick: 'alice',
        ident: 'fake',
        hostname: 'evil.host',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(denied).toBe(false);
    });

    it('denies an account pattern user when ctx has no account data', () => {
      // Without the account lookup wired, ctx.account undefined + no
      // accountLookup means the record only matches via hostmask. `$a:`
      // patterns must not fall back to "pass" under these conditions.
      perms.addUser('alice', '$a:AliceAcct', 'o', 'REPL');
      const allowed = perms.checkFlags('+o', {
        nick: 'alice',
        ident: 'real',
        hostname: 'host.com',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(allowed).toBe(false);
    });

    it('accepts an account pattern user when ctx.account is authoritative', () => {
      perms.addUser('alice', '$a:AliceAcct', 'o', 'REPL');
      const allowed = perms.checkFlags('+o', {
        nick: 'someoneElse',
        ident: 'x',
        hostname: 'different.host',
        account: 'AliceAcct',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(allowed).toBe(true);
    });

    it('accepts an account pattern user when accountLookup resolves the nick', () => {
      perms.addUser('alice', '$a:AliceAcct', 'o', 'REPL');
      perms.setAccountLookup((nick) => (nick === 'alice' ? 'AliceAcct' : null));
      const allowed = perms.checkFlags('+o', {
        nick: 'alice',
        ident: 'any',
        hostname: 'any.host',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(allowed).toBe(true);
    });

    it('prefers ctx.account over accountLookup when both disagree', () => {
      perms.addUser('alice', '$a:RealAlice', 'o', 'REPL');
      perms.setAccountLookup(() => 'StaleAccount');
      const allowed = perms.checkFlags('+o', {
        nick: 'alice',
        ident: 'x',
        hostname: 'x',
        account: 'RealAlice', // authoritative per-message tag
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // setGlobalFlags / setChannelFlags — error paths
  // -------------------------------------------------------------------------

  describe('setGlobalFlags / setChannelFlags error paths', () => {
    it('should throw when setting global flags for nonexistent user', () => {
      expect(() => perms.setGlobalFlags('nobody', 'o', 'REPL')).toThrow('not found');
    });

    it('setGlobalFlags without source defaults to "unknown"', () => {
      perms.addUser('flaguser', '*!f@h', 'v', 'REPL');
      expect(() => perms.setGlobalFlags('flaguser', 'o')).not.toThrow();
      expect(perms.getUser('flaguser')!.global).toBe('o');
    });

    it('should throw when setting channel flags for nonexistent user', () => {
      expect(() => perms.setChannelFlags('nobody', '#test', 'o', 'REPL')).toThrow('not found');
    });

    it('should delete channel entry when flags normalize to empty', () => {
      perms.addUser('user1', '*!u@h', 'o', 'REPL');
      perms.setChannelFlags('user1', '#test', 'o', 'REPL');
      expect(perms.getUser('user1')!.channels['#test']).toBe('o');

      // Set empty flags — should remove the channel entry
      perms.setChannelFlags('user1', '#test', '', 'REPL');
      expect(perms.getUser('user1')!.channels['#test']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Insecure hostmask warning
  // -------------------------------------------------------------------------

  describe('insecure hostmask warning', () => {
    it('should warn about nick!*@* hostmask for privileged users', () => {
      const logger = createLogger('debug');
      // Spy on Logger.prototype.warn before creating the Permissions instance,
      // so the child logger created internally also gets intercepted.
      const warnSpy = vi.spyOn(logger.constructor.prototype, 'warn');
      const permsWithLogger = new Permissions(null, logger);
      permsWithLogger.addUser('insecure', 'admin!*@*', 'o', 'REPL');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SECURITY'));
      warnSpy.mockRestore();
    });

    it('should not warn when hostmask has no ! separator (covers bangIdx === -1 branch)', () => {
      const logger = createLogger('debug');
      const warnSpy = vi.spyOn(logger.constructor.prototype, 'warn');
      const permsWithLogger = new Permissions(null, logger);
      // Hostmask without '!' — warnInsecureHostmask returns early at bangIdx === -1
      permsWithLogger.addUser('noBang', 'justahostname', 'o', 'REPL');

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('SECURITY'));
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Channel owner flag and null channel branches
  // -------------------------------------------------------------------------

  describe('channel owner flag and null channel in userHasFlag', () => {
    it('should grant all flags when user has owner flag (n) in channel-specific flags', () => {
      perms.addUser('chanowner', '*!chanowner@host', '', 'REPL');
      perms.setChannelFlags('chanowner', '#vip', 'n', 'REPL');

      const ctx = {
        nick: 'chanowner',
        ident: 'chanowner',
        hostname: 'host',
        channel: '#vip',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      };
      // Owner flag in channel implies all flags for that channel (covers line 303 true branch)
      expect(perms.checkFlags('+o', ctx)).toBe(true);
      expect(perms.checkFlags('+m', ctx)).toBe(true);
    });

    it('should skip channel flag check when channel is null (covers false branch of if(channel))', () => {
      // User has NO global flags but DOES have channel flags — so global check falls through
      // With channel=null, the channel block is skipped entirely → returns false
      perms.addUser('chanonly', '*!chanonly@host', '', 'REPL');
      perms.setChannelFlags('chanonly', '#vip', 'o', 'REPL');

      const ctx = {
        nick: 'chanonly',
        ident: 'chanonly',
        hostname: 'host',
        channel: null,
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      };
      // channel is null → if(channel) is false → no channel flag checked → false
      expect(perms.checkFlags('+o', ctx)).toBe(false);
    });

    it('returns false when channelFlags exist but do not include the requested flag', () => {
      // User has 'v' in #test but we check '+o' → channelFlags.includes('o') is false
      perms.addUser('voiceonly', '*!vo@host', '', 'REPL');
      perms.setChannelFlags('voiceonly', '#test', 'v', 'REPL');

      const ctx = {
        nick: 'voiceonly',
        ident: 'vo',
        hostname: 'host',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      };
      // channelFlags='v', checking '+o': channelFlags.includes('o') → false → covers line 304 false branch
      expect(perms.checkFlags('+o', ctx)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // normalizeFlags with invalid characters
  // -------------------------------------------------------------------------

  describe('normalizeFlags strips invalid characters', () => {
    it('should strip invalid flag characters (covers false branch in normalizeFlags loop)', () => {
      // 'x', 'z' are not in VALID_FLAGS ('nmov') — they should be stripped
      perms.addUser('flagtest', '*!ft@host', 'nxoz', 'REPL');
      const user = perms.getUser('flagtest');
      // Only valid flags remain: n and o
      expect(user!.global).toBe('no');
    });
  });

  // -------------------------------------------------------------------------
  // loadFromDb with no database
  // -------------------------------------------------------------------------

  describe('loadFromDb with no database', () => {
    it('does nothing when no database is configured (covers if(!this.db) early return)', () => {
      // perms from beforeEach has no db — loadFromDb should return immediately
      expect(() => perms.loadFromDb()).not.toThrow();
      // No users loaded since no db
      expect(perms.listUsers()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listUsers
  // -------------------------------------------------------------------------

  describe('listUsers', () => {
    it('should return all users', () => {
      perms.addUser('alice', '*!a@h', 'o', 'REPL');
      perms.addUser('bob', '*!b@h', 'v', 'REPL');
      perms.addUser('charlie', '*!c@h', 'n', 'REPL');

      const users = perms.listUsers();
      expect(users).toHaveLength(3);
      const handles = users.map((u) => u.handle).sort();
      expect(handles).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should return empty array when no users', () => {
      expect(perms.listUsers()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Database persistence
  // -------------------------------------------------------------------------

  describe('database persistence', () => {
    let db: BotDatabase;

    beforeEach(() => {
      db = new BotDatabase(':memory:');
      db.open();
    });

    afterEach(() => {
      db.close();
    });

    it('should save and load users from the database', () => {
      // Create permissions with db, add users
      const perms1 = new Permissions(db);
      perms1.addUser('admin', '*!admin@secure.host', 'nmov', 'REPL');
      perms1.addUser('oper', '*!oper@host', 'o', 'REPL');
      perms1.setChannelFlags('oper', '#main', 'ov', 'REPL');

      // Create a new Permissions instance with the same db and load
      const perms2 = new Permissions(db);
      perms2.loadFromDb();

      // Verify data survived
      const admin = perms2.getUser('admin');
      expect(admin).not.toBeNull();
      expect(admin!.handle).toBe('admin');
      expect(admin!.hostmasks).toEqual(['*!admin@secure.host']);
      expect(admin!.global).toBe('nmov');

      const oper = perms2.getUser('oper');
      expect(oper).not.toBeNull();
      expect(oper!.handle).toBe('oper');
      expect(oper!.global).toBe('o');
      expect(oper!.channels).toEqual({ '#main': 'ov' });
    });

    it('should persist changes after addUser', () => {
      const p = new Permissions(db);
      p.addUser('test', '*!t@h', 'v', 'REPL');

      // Verify the DB has the record
      const raw = db.get('_permissions', 'test');
      expect(raw).not.toBeNull();
      const record = JSON.parse(raw!);
      expect(record.handle).toBe('test');
    });

    it('should persist changes after removeUser', () => {
      const p = new Permissions(db);
      p.addUser('test', '*!t@h', 'v', 'REPL');
      p.removeUser('test', 'REPL');

      const raw = db.get('_permissions', 'test');
      expect(raw).toBeNull();
    });

    it('should skip corrupt records when loading from db', () => {
      // Manually insert a corrupt JSON record into the _permissions namespace
      db.set('_permissions', 'corrupt', '{not valid json!!!');
      // JSON-valid but shape-invalid rows are also rejected by isUserRecord
      db.set('_permissions', 'wrongshape', JSON.stringify({ handle: 'wrongshape' }));
      // Also insert a valid record
      db.set(
        '_permissions',
        'valid',
        JSON.stringify({
          handle: 'valid',
          hostmasks: ['*!v@h'],
          global: 'o',
          channels: {},
        }),
      );

      const p = new Permissions(db);
      p.loadFromDb();

      // Corrupt and malformed records are skipped, valid one loaded.
      expect(p.getUser('corrupt')).toBeNull();
      expect(p.getUser('wrongshape')).toBeNull();
      expect(p.getUser('valid')).not.toBeNull();
      expect(p.getUser('valid')!.global).toBe('o');
    });
  });

  describe('setCasemapping', () => {
    it('rfc1459 (default): channel name with [ is folded to { in key', () => {
      const p = new Permissions();
      p.addUser('alpha', '*!*@host', 'o');
      p.setChannelFlags('alpha', '#[test]', 'v');

      const record = p.getUser('alpha')!;
      // rfc1459: #[test] → #{test}
      expect(record.channels['#{test}']).toBe('v');
    });

    it('ascii: channel name with [ is NOT folded', () => {
      const p = new Permissions();
      p.setCasemapping('ascii');
      p.addUser('beta', '*!*@host', 'o');
      p.setChannelFlags('beta', '#[test]', 'v');

      const record = p.getUser('beta')!;
      // ascii: #[test] stays as #[test]
      expect(record.channels['#[test]']).toBe('v');
      expect(record.channels['#{test}']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // syncUser — default source fallback
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // password_hash
  // -------------------------------------------------------------------------

  describe('password hash persistence', () => {
    let db: BotDatabase;

    beforeEach(() => {
      db = new BotDatabase(':memory:');
      db.open();
    });

    afterEach(() => {
      db.close();
    });

    it('setPasswordHash stores a hash on an existing user', () => {
      const p = new Permissions(db);
      p.addUser('admin', '*!a@h', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$deadbeef$cafe', 'REPL');

      expect(p.getPasswordHash('admin')).toBe('scrypt$deadbeef$cafe');
    });

    it('setPasswordHash round-trips through the database', () => {
      const p1 = new Permissions(db);
      p1.addUser('admin', '*!a@h', 'n', 'REPL');
      p1.setPasswordHash('admin', 'scrypt$deadbeef$cafe', 'REPL');

      const p2 = new Permissions(db);
      p2.loadFromDb();

      expect(p2.getPasswordHash('admin')).toBe('scrypt$deadbeef$cafe');
    });

    it('setPasswordHash throws for unknown user', () => {
      const p = new Permissions(db);
      expect(() => p.setPasswordHash('nobody', 'scrypt$x$y', 'REPL')).toThrow('not found');
    });

    it('getPasswordHash returns null for user with no hash', () => {
      const p = new Permissions(db);
      p.addUser('admin', '*!a@h', 'n', 'REPL');
      expect(p.getPasswordHash('admin')).toBeNull();
    });

    it('getPasswordHash returns null for unknown user', () => {
      const p = new Permissions(db);
      expect(p.getPasswordHash('nobody')).toBeNull();
    });

    it('clearPasswordHash removes the hash', () => {
      const p = new Permissions(db);
      p.addUser('admin', '*!a@h', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$x$y', 'REPL');
      p.clearPasswordHash('admin', 'REPL');
      expect(p.getPasswordHash('admin')).toBeNull();
    });

    it('clearPasswordHash throws for unknown user', () => {
      const p = new Permissions(db);
      expect(() => p.clearPasswordHash('nobody', 'REPL')).toThrow('not found');
    });

    it('existing users (no hash) load correctly — backward compat', () => {
      // Write a legacy record with no password_hash field at all
      db.set(
        '_permissions',
        'legacy',
        JSON.stringify({
          handle: 'legacy',
          hostmasks: ['*!leg@host'],
          global: 'n',
          channels: {},
        }),
      );

      const p = new Permissions(db);
      p.loadFromDb();

      const user = p.getUser('legacy');
      expect(user).not.toBeNull();
      expect(user!.password_hash).toBeUndefined();
      expect(p.getPasswordHash('legacy')).toBeNull();
    });

    it('emits user:passwordChanged on set', () => {
      const eventBus = {
        emit: vi.fn(),
      } as unknown as import('../../src/event-bus').BotEventBus;
      const p = new Permissions(db, undefined, eventBus);
      p.addUser('admin', '*!a@h', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$x$y', 'REPL');
      expect(eventBus.emit).toHaveBeenCalledWith('user:passwordChanged', 'admin');
    });

    it('never records the hash in logs or mod_log', () => {
      const logs: string[] = [];
      const mockLogger: import('../../src/logger').LoggerLike = {
        info: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        debug: () => {},
        error: () => {},
        child: () => mockLogger,
        setLevel: () => {},
        getLevel: () => 'info',
      };

      const p = new Permissions(db, mockLogger);
      p.addUser('admin', '*!a@h', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$deadbeef$cafe', 'REPL');
      p.clearPasswordHash('admin', 'REPL');

      for (const line of logs) {
        expect(line).not.toContain('scrypt$deadbeef$cafe');
      }
      const modLog = db.getModLog();
      const serialized = JSON.stringify(modLog);
      expect(serialized).not.toContain('scrypt$deadbeef$cafe');
    });
  });

  // -------------------------------------------------------------------------
  // PluginPermissions does not expose password_hash
  // -------------------------------------------------------------------------

  describe('plugin-facing permissions strips password_hash', () => {
    it('createPluginPermissionsApi omits password_hash from findByHostmask', async () => {
      const { createPluginPermissionsApi } = await import('../../src/plugin-api-factory');
      const p = new Permissions();
      p.addUser('admin', '*!a@host', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$secretsalt$secrethash', 'REPL');

      const pluginPerms = createPluginPermissionsApi(p);
      const record = pluginPerms.findByHostmask('anynick!a@host');
      expect(record).not.toBeNull();
      expect(record!.handle).toBe('admin');
      expect(record!.hostmasks).toEqual(['*!a@host']);
      expect(record!.global).toBe('n');
      // Runtime shape check — the type has been narrowed to PublicUserRecord,
      // and the factory must also strip the field at runtime so plugins can't
      // reflect it back via `Object.keys` or `JSON.stringify`.
      expect((record as unknown as { password_hash?: string }).password_hash).toBeUndefined();
      expect(Object.keys(record!)).not.toContain('password_hash');
    });

    it('createPluginPermissionsApi returns null for unknown hostmask', async () => {
      const { createPluginPermissionsApi } = await import('../../src/plugin-api-factory');
      const p = new Permissions();
      const pluginPerms = createPluginPermissionsApi(p);
      expect(pluginPerms.findByHostmask('nobody!nobody@nowhere')).toBeNull();
    });

    it('mutating the plugin view does not alter the underlying record', async () => {
      const { createPluginPermissionsApi } = await import('../../src/plugin-api-factory');
      const p = new Permissions();
      p.addUser('admin', '*!a@host', 'n', 'REPL');
      p.setPasswordHash('admin', 'scrypt$s$h', 'REPL');

      const pluginPerms = createPluginPermissionsApi(p);
      const view = pluginPerms.findByHostmask('anynick!a@host')!;
      // Attempting to splat a hash onto the plugin view must not leak into the real record.
      (view as unknown as { password_hash: string }).password_hash = 'tampered';
      expect(p.getPasswordHash('admin')).toBe('scrypt$s$h');
    });
  });

  describe('syncUser', () => {
    it('uses "botlink" as default source when source is omitted', () => {
      const infoMsgs: string[] = [];
      const mockLogger: import('../../src/logger').LoggerLike = {
        info: (msg: string) => infoMsgs.push(msg),
        warn: () => {},
        debug: () => {},
        error: () => {},
        child: () => mockLogger,
        setLevel: () => {},
        getLevel: () => 'info',
      };

      const p = new Permissions(undefined, mockLogger);
      p.syncUser('synced-user', ['*!test@host'], 'o', {});

      const user = p.getUser('synced-user');
      expect(user).not.toBeNull();
      expect(user!.global).toBe('o');
      expect(infoMsgs.some((m) => m.includes('from botlink'))).toBe(true);
    });

    it('uses provided source when given', () => {
      const infoMsgs: string[] = [];
      const mockLogger: import('../../src/logger').LoggerLike = {
        info: (msg: string) => infoMsgs.push(msg),
        warn: () => {},
        debug: () => {},
        error: () => {},
        child: () => mockLogger,
        setLevel: () => {},
        getLevel: () => 'info',
      };

      const p = new Permissions(undefined, mockLogger);
      p.syncUser('synced-user2', ['*!test@host'], 'o', {}, 'manual');

      expect(infoMsgs.some((m) => m.includes('from manual'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // saveToDb: transactional per-record upsert (stability audit 2026-04-14)
  // -------------------------------------------------------------------------

  describe('saveToDb: transactional per-record upsert', () => {
    let permsDb: BotDatabase;
    let withDbPerms: Permissions;

    beforeEach(() => {
      permsDb = new BotDatabase(':memory:');
      permsDb.open();
      withDbPerms = new Permissions(permsDb, null);
    });

    afterEach(() => {
      permsDb.close();
    });

    it('does not delete rows whose key still exists in memory', () => {
      // Previously saveToDb() wiped the whole `_permissions` namespace
      // and re-inserted every user on every single-user mutation. This
      // test guards that a setGlobalFlags on one user leaves the other
      // users untouched at the storage layer.
      withDbPerms.addUser('alice', '*!alice@*', 'n', 'test');
      withDbPerms.addUser('bob', '*!bob@*', 'o', 'test');
      withDbPerms.setGlobalFlags('alice', 'nm', 'test');

      const keys = permsDb
        .list('_permissions')
        .map((r) => r.key)
        .sort();
      expect(keys).toEqual(['alice', 'bob']);
    });

    it('drops rows for removed users', () => {
      withDbPerms.addUser('alice', '*!alice@*', 'n', 'test');
      withDbPerms.addUser('bob', '*!bob@*', 'o', 'test');
      withDbPerms.removeUser('bob', 'test');
      const keys = permsDb.list('_permissions').map((r) => r.key);
      expect(keys).toEqual(['alice']);
    });
  });

  describe('initialUsers seed', () => {
    it('pre-populates the user map from the constructor seed', () => {
      const seeded = new Permissions(null, null, null, [
        [
          'admin',
          {
            handle: 'admin',
            hostmasks: ['*!admin@example.com'],
            global: 'nm',
            channels: { '#chan': 'o' },
          },
        ],
      ]);
      const user = seeded.getUser('admin');
      expect(user).not.toBeNull();
      expect(user!.global).toBe('nm');
      expect(user!.channels['#chan']).toBe('o');
    });
  });
});
