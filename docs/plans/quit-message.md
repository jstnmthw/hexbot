# Plan: Configurable Quit Message

## Summary

Replace the hardcoded `'Shutting down'` quit message with a configurable string. The default will be `Hexbot v{version}` (read from `package.json`) so the bot announces itself on quit without any config change required.

## Feasibility

- **Alignment**: Trivial config addition, fits the existing `BotConfig` pattern exactly.
- **Dependencies**: None — `readPackageVersion()` already exists in `bot.ts`.
- **Blockers**: None.
- **Complexity**: XS (< 30 minutes, 3 files).
- **Risk**: None. IRC QUIT messages are a plain string; irc-framework's `client.quit()` accepts any string.

## Phases

### Phase 1: Config type + default

**Goal:** Add the optional field to the config shape and use it in shutdown.

- [ ] `src/types.ts` — add `quit_message?: string` to `BotConfig`
- [ ] `src/bot.ts` — change the `client.quit(...)` call in `shutdown()` to:
  ```typescript
  const msg = this.config.quit_message ?? `Hexbot v${this.readPackageVersion()}`;
  this.client.quit(msg);
  ```
- [ ] `config/bot.example.json` — add the optional field:
  ```json
  "quit_message": "Hexbot v0.1.0"
  ```
- [ ] **Verify**: Start the bot, then SIGINT it. The IRC server should show the configured message (or the default version string) in the quit line.

## Config changes

New optional field in `bot.json`:

```json
{
  "quit_message": "Hexbot v0.1.0"
}
```

If omitted, defaults to `Hexbot v{version}` where `{version}` comes from `package.json`.

## Database changes

None.

## Test plan

No automated test needed — the only testable thing is that the string reaches `client.quit()`, which is a one-liner. Manual verification: connect to IRC, shut down the bot, observe the quit message in the client.

## Open questions

None — ready to build.
