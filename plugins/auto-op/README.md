# auto-op

Automatically ops or voices users when they join a channel, based on their permission flags.

## How it works

When a user joins a channel, the plugin:

1. Checks if the user's hostmask matches a known user in the permissions system
2. Checks the user's flags (global + channel-specific)
3. If NickServ verification is required for the flag level, queries NickServ ACC and waits for a response
4. If verified (or verification not required), applies the appropriate mode

## Flags

| Flag | Mode applied |
|------|-------------|
| `n` (owner) | +o |
| `m` (master) | +o |
| `o` (op) | +o |
| `v` (voice) | +v |

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `verify_timeout_ms` | number | 5000 | Timeout for NickServ ACC verification |
| `notify_on_fail` | boolean | false | Send a notice to the user if verification fails |
| `op_flags` | string[] | `["n", "m", "o"]` | Flags that trigger +o |
| `voice_flags` | string[] | `["v"]` | Flags that trigger +v |

## Security

- Hostmask is always checked first — NickServ is only queried if the hostmask already matches
- On verification timeout, the mode is NOT applied (fail closed)
- Failed verification attempts are logged
