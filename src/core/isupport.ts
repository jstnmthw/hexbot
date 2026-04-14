// HexBot — ISUPPORT (RPL 005) parser
//
// IRC servers advertise their feature set in the ISUPPORT numeric (005).
// irc-framework stores the raw values on `client.network.options`, exposing
// them via `client.network.supports(key)` — but most come back as strings or
// loosely-typed arrays, and consumers would otherwise re-parse them on every
// lookup. This module canonicalises the handful of values hexbot cares about
// into a single typed snapshot that modules (`ChannelState`, `IRCCommands`,
// `IRCBridge`, `MessageQueue`) receive at `registered` time.
//
// What we parse and why:
//
// - **PREFIX** — `(qaohv)~&@%+`: the prefix modes a user can hold in a channel
//   and their status symbols. Networks vary wildly here (Solanum/Libera use
//   `(ov)@+`; InspIRCd/Unreal add `q`/`a`; ngIRCd ships only `(ov)@+`).
//   Without parsing this, hexbot's channel-state can't map NAMES symbols to
//   modes correctly and can't tell a MODE change on `q`/`a` from any other.
//
// - **CHANMODES** — `A,B,C,D`: four comma-separated lists naming which modes
//   take a parameter and when. Type A (list modes, e.g. `b`/`e`/`I`) always
//   take a param; Type B (`k`) always take a param; Type C (`l`) take a param
//   only when set (`+`); Type D (`imnpst…`) never take a param. The mode
//   batcher uses this to allocate params to the right chars instead of
//   guessing 1:1.
//
// - **MODES** — max number of mode changes per MODE line. Solanum advertises 4,
//   Unreal 12, InspIRCd 20. Feeding this into the batcher lets hexbot ship
//   bursts efficiently on networks that allow it.
//
// - **CHANTYPES** — which characters can start a channel name. Most networks
//   use `#&`; IRCnet also uses `!`. Hardcoding `#&` silently drops joins and
//   inbound events on `!` channels.
//
// - **TARGMAX** — per-command target caps, e.g. `PRIVMSG:4,NOTICE:4,JOIN:`.
//   Consumed by MessageQueue in Phase 6 to avoid server-side target-change
//   limits (Libera's notorious "target change" throttle).
//
// - **CASEMAPPING** — the canonical case-folding rule. Already applied via
//   the `setCasemapping` pipeline; we surface it here so consumers can log
//   a warning when the server advertises something we don't recognise
//   (`rfc7613` etc.) instead of silently falling back to `rfc1459`.
//
// Fallback defaults match RFC 1459/2812 so a ChannelState / IRCCommands
// constructed in unit tests (no IRC connection) behaves sensibly without
// an explicit `setCapabilities` call.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed snapshot of the server's ISUPPORT (005) capabilities. */
export interface ServerCapabilities {
  /** Prefix modes in descending privilege order. Example: `['q','a','o','h','v']`. */
  prefixModes: string[];
  /** Mode char → status symbol. Example: `{ o: '@', v: '+' }`. */
  prefixToSymbol: Record<string, string>;
  /** Status symbol → mode char. Example: `{ '@': 'o', '+': 'v' }`. */
  symbolToPrefix: Record<string, string>;
  /** Set of prefix mode chars for O(1) membership tests. */
  prefixSet: Set<string>;
  /** CHANMODES type A — list modes (always take a param). */
  chanmodesA: Set<string>;
  /** CHANMODES type B — always-param setting modes. */
  chanmodesB: Set<string>;
  /** CHANMODES type C — param only on `+`. */
  chanmodesC: Set<string>;
  /** CHANMODES type D — flag modes (never take a param). */
  chanmodesD: Set<string>;
  /** Max mode changes per MODE line (from `MODES=`). Default 3 per RFC 2812. */
  modesPerLine: number;
  /** Channel prefix chars, e.g. `'#&'`. Default `'#&'` per RFC. */
  chantypes: string;
  /** TARGMAX map: uppercase command → max simultaneous targets (or `Infinity`). */
  targmax: Record<string, number>;
  /** Raw advertised CASEMAPPING, or null. Consumers use it to warn on unknown values. */
  casemapping: string | null;
  /** True if `modeChar` takes a parameter when applied in `direction`. */
  expectsParam(modeChar: string, direction: '+' | '-'): boolean;
  /** True if `name` starts with one of the advertised channel prefix chars. */
  isValidChannel(name: string): boolean;
}

/** Minimal shape we need from the irc-framework client. */
export interface SupportsProvider {
  network: { supports(feature: string): unknown };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Build a typed capabilities snapshot from a connected irc-framework client.
 * Safe to call before `registered` — unknown values fall back to RFC defaults.
 */
export function parseISupport(client: SupportsProvider): ServerCapabilities {
  const supports = (key: string): unknown => client.network.supports(key);

  // PREFIX — irc-framework parses `(qaohv)~&@%+` into an array of
  // `{ symbol, mode }` objects, ordered from highest to lowest rank.
  const prefixRaw = supports('PREFIX');
  const prefixModes: string[] = [];
  const prefixToSymbol: Record<string, string> = {};
  const symbolToPrefix: Record<string, string> = {};
  if (Array.isArray(prefixRaw) && prefixRaw.length > 0) {
    for (const raw of prefixRaw) {
      /* v8 ignore next */
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as { symbol?: unknown; mode?: unknown };
      /* v8 ignore next */
      if (typeof entry.mode !== 'string' || typeof entry.symbol !== 'string') continue;
      prefixModes.push(entry.mode);
      prefixToSymbol[entry.mode] = entry.symbol;
      symbolToPrefix[entry.symbol] = entry.mode;
    }
  }
  if (prefixModes.length === 0) {
    // RFC-era fallback — every IRC network supports op/voice.
    prefixModes.push('q', 'a', 'o', 'h', 'v');
    prefixToSymbol.q = '~';
    prefixToSymbol.a = '&';
    prefixToSymbol.o = '@';
    prefixToSymbol.h = '%';
    prefixToSymbol.v = '+';
    symbolToPrefix['~'] = 'q';
    symbolToPrefix['&'] = 'a';
    symbolToPrefix['@'] = 'o';
    symbolToPrefix['%'] = 'h';
    symbolToPrefix['+'] = 'v';
  }
  const prefixSet = new Set(prefixModes);

  // CHANMODES — irc-framework splits `beI,k,l,imnpstr` into `['beI','k','l','imnpstr']`.
  const cmRaw = supports('CHANMODES');
  const cmArr: string[] =
    Array.isArray(cmRaw) && cmRaw.every((x): x is string => typeof x === 'string')
      ? cmRaw
      : ['beI', 'k', 'l', 'imnpstr'];
  const chanmodesA = new Set(cmArr[0] ?? 'beI');
  const chanmodesB = new Set(cmArr[1] ?? 'k');
  const chanmodesC = new Set(cmArr[2] ?? 'l');
  const chanmodesD = new Set(cmArr[3] ?? 'imnpstr');

  // MODES — max mode changes per line. RFC 2812 caps at 3.
  const modesRaw = supports('MODES');
  const modesPerLine =
    typeof modesRaw === 'string' && /^\d+$/.test(modesRaw)
      ? Math.max(1, parseInt(modesRaw, 10))
      : typeof modesRaw === 'number' && modesRaw > 0
        ? modesRaw
        : 3;

  // CHANTYPES — irc-framework stores it as a char array; fall back to '#&'.
  const ctRaw = supports('CHANTYPES');
  const chantypes =
    Array.isArray(ctRaw) && ctRaw.length > 0
      ? ctRaw.map(String).join('')
      : typeof ctRaw === 'string' && ctRaw.length > 0
        ? ctRaw
        : '#&';

  // TARGMAX — raw string of the form `PRIVMSG:4,NOTICE:4,JOIN:`; empty value = unlimited.
  const targmaxRaw = supports('TARGMAX');
  const targmax: Record<string, number> = {};
  if (typeof targmaxRaw === 'string' && targmaxRaw.length > 0) {
    for (const pair of targmaxRaw.split(',')) {
      const [rawCmd, rawVal] = pair.split(':');
      if (!rawCmd) continue;
      const cmd = rawCmd.toUpperCase();
      if (rawVal === undefined || rawVal === '') {
        targmax[cmd] = Infinity;
      } else {
        const n = parseInt(rawVal, 10);
        if (Number.isFinite(n) && n > 0) targmax[cmd] = n;
      }
    }
  }

  const casemappingRaw = supports('CASEMAPPING');
  const casemapping = typeof casemappingRaw === 'string' ? casemappingRaw : null;

  return {
    prefixModes,
    prefixToSymbol,
    symbolToPrefix,
    prefixSet,
    chanmodesA,
    chanmodesB,
    chanmodesC,
    chanmodesD,
    modesPerLine,
    chantypes,
    targmax,
    casemapping,
    expectsParam(modeChar: string, direction: '+' | '-'): boolean {
      if (prefixSet.has(modeChar)) return true;
      if (chanmodesA.has(modeChar) || chanmodesB.has(modeChar)) return true;
      if (chanmodesC.has(modeChar)) return direction === '+';
      return false;
    },
    isValidChannel(name: string): boolean {
      if (typeof name !== 'string' || name.length === 0) return false;
      return chantypes.includes(name[0]);
    },
  };
}

/**
 * RFC-conformant default capabilities for modules constructed before a
 * server connection exists (unit tests, pre-`registered` state).
 */
export function defaultServerCapabilities(): ServerCapabilities {
  return parseISupport({ network: { supports: () => undefined } });
}
