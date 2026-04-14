// HexBot — IRC disconnect reason classifier
//
// Pure classification: takes an IRC ERROR / socket error reason string and
// returns a ReconnectPolicy the driver uses to pick its backoff curve. Has
// no I/O and no state — lives apart from connection-lifecycle so it can be
// unit-tested directly and so the lifecycle file stays focused on wiring.

/**
 * A retry tier plus the human-readable label that should appear in logs and
 * the `.status` command. The driver in `reconnect-driver.ts` picks the
 * backoff curve from the tier; connection-lifecycle only classifies.
 *
 * - `transient`    — TCP hiccup, ping timeout, server restart, unknown reason.
 *                    Short exponential backoff (1s → 30s cap).
 * - `rate-limited` — K-line, DNSBL, throttled. Long backoff (5min → 30min cap);
 *                    the bot keeps retrying indefinitely, since these expire.
 * - `fatal`        — bad SASL, unsupported mech, cert mismatch. Process exits
 *                    so a supervisor can page someone instead of the bot
 *                    silently locking an account in a retry loop.
 */
export type ReconnectPolicy =
  | { tier: 'transient'; label?: string }
  | { tier: 'rate-limited'; label: string }
  | { tier: 'fatal'; label: string; exitCode: number };

// Exit code 2 = fatal config error. A single code keeps supervisor wrappers
// simple; the log line carries the actual cause.
const FATAL_EXIT_CODE = 2;

const FATAL_PATTERNS: Array<[RegExp, string]> = [
  // SASL 904 — "SASL authentication failed". Must fire on first hit, before
  // the account-lockout counter on services ticks past its threshold.
  [/SASL.*(authentication\s+failed|failed)/i, 'SASL authentication failed'],
  // SASL 908 — server advertises no acceptable mechanism for us. Config
  // error, retrying won't fix it.
  [/mechanism(?:s)?\s+not\s+supported/i, 'SASL mechanism not supported'],
  [/no\s+such\s+mechanism/i, 'SASL mechanism not supported'],
  // TLS cert verification failures surfaced by node's tls module. If the
  // operator set tls_verify=true, these are permanent until config change.
  [/Hostname\/IP\s+does\s+not\s+match/i, 'TLS hostname mismatch'],
  [/unable\s+to\s+verify\s+the\s+first\s+certificate/i, 'TLS certificate untrusted'],
  [/self[-\s]signed\s+certificate/i, 'TLS self-signed certificate'],
  [/CERT_HAS_EXPIRED/i, 'TLS certificate expired'],
];

const RATE_LIMITED_PATTERNS: Array<[RegExp, string]> = [
  // Ban-class responses — operators lift these, auto-klines expire, DNSBLs
  // drain. Long backoff lets the bot recover automatically.
  [/K[\s-]?Line/i, 'K-Lined'],
  [/G[\s-]?Line/i, 'G-Lined'],
  [/Z[\s-]?Line/i, 'Z-Lined'],
  [/Banned\s+from\s+server/i, 'banned from server'],
  [/You are banned/i, 'banned from server'],
  [/You are not welcome/i, 'banned from server'],
  [/DNSBL/i, 'blocked by DNSBL'],
  [/Your\s+(host|IP)\s+is\s+listed/i, 'IP listed in DNSBL'],
  // Throttle-class responses — transient but we need to slow down hard.
  [/Throttled/i, 'throttled'],
  [/Reconnect(?:ing)?\s+too\s+fast/i, 'reconnecting too fast'],
  [/Too\s+many\s+connections/i, 'too many connections'],
  [/Connection\s+limit/i, 'connection limit reached'],
  [/Excess\s+Flood/i, 'excess flood'],
];

const TRANSIENT_LABEL_PATTERNS: Array<[RegExp, string]> = [
  // These still classify as `transient` — the label just makes the log
  // line name the cause instead of saying "unknown reason".
  [/ping\s+timeout/i, 'ping timeout'],
  [/registration\s+(?:tim(?:e|ed)\s*)?out/i, 'registration timeout'],
  [/server\s+shutting\s+down/i, 'server shutting down'],
  [/restart\s+in\s+progress/i, 'server restart'],
  [/closing\s+link/i, 'closing link'],
];

/**
 * Inspect an IRC `ERROR :...` reason (from `irc error` / socket error /
 * TLS failure) and assign a retry tier. Unknown reasons fall through to
 * `'transient'` with no label — the common case on a flaky network.
 *
 * Exported so unit tests can exercise the pattern matrix directly.
 */
export function classifyCloseReason(reason: string | null): ReconnectPolicy {
  if (!reason) return { tier: 'transient' };
  for (const [re, label] of FATAL_PATTERNS) {
    if (re.test(reason)) return { tier: 'fatal', label, exitCode: FATAL_EXIT_CODE };
  }
  for (const [re, label] of RATE_LIMITED_PATTERNS) {
    if (re.test(reason)) return { tier: 'rate-limited', label };
  }
  for (const [re, label] of TRANSIENT_LABEL_PATTERNS) {
    if (re.test(reason)) return { tier: 'transient', label };
  }
  return { tier: 'transient' };
}
