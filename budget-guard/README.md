# budget-guard

<img src=".claude-plugin/icon.png" alt="" width="80" height="80" align="right">

English | [Русский](README.ru.md)

Prompt-cache keepalive and budget warnings for Claude Code. The mod watches the main
thread's requests, subscription limits, and context size. Its commands and notifications
are currently in Russian.

- Keep a five-minute prompt cache warm during a short idle stretch.
- Disable keepalive for just the current session with `/budget off`.
- Warn at configurable 5h/7d usage and context thresholds.
- Ask for a second `Enter` before sending a large prompt into a cold cache.
- Add a short budget reminder to submitted prompts when usage is high.

**Keepalive makes real background model requests and consumes usage.** It re-reads the
main thread's prefix through `$.model.fork`; it is not free and does not raise provider
limits. Savings depend on the cache actually being reused. Turn it off if your provider
uses a different cache lifetime or you do not want background requests.

## Install

Requires Claude Code with support for hooks modules and `$.model.fork`.
At the Claude Code prompt:

```text
/plugin install budget-guard --marketplace Hoxiee/claude-code-mods
```

Confirm adding the marketplace with `y`, then choose the installation scope and options.
Or from a shell:

```sh
claude plugin install budget-guard --marketplace Hoxiee/claude-code-mods
```

For local development:

```sh
claude --plugin-dir /path/to/neocc-mods/budget-guard
```

## Commands

| Command | Action |
| --- | --- |
| `/budget` | Show limits, context, cache age, and keepalive counters |
| `/budget on` | Enable keepalive in the current session |
| `/budget off` | Disable keepalive in the current session; warnings and the cold-cache guard stay active |

Finished a task but keeping the CLI open to read? Run `/budget off`. The keepalive
timer stops; no new pings or retries start. An already-running ping may finish.
Run `/budget on` to resume. If the cache has already expired, the mod waits for a
real request instead of paying to warm the cold prefix again.

The toggle lives in the current session's state and survives a mod hot reload.
Ordinary requests do not turn keepalive back on. Other sessions are unaffected;
a new session uses the `keepalive` option, which the command does not change.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `keepalive` | `true` | Enable background keepalive requests by default in new sessions |
| `keepaliveMinutes` | `"30"` | Idle horizon after the last real request |
| `keepaliveMinTokens` | `"0"` | Minimum context size for keepalive; `0` disables the threshold |
| `coldCacheGuard` | `"confirm"` | `confirm`, `warn`, or `off` |
| `coldCacheMinTokens` | `"60000"` | Minimum context size for the cold-cache guard |
| `limitThresholds` | `"50,75,90,95"` | 5h/7d usage thresholds for warnings |
| `budgetNudgeAt` | `"70"` | Usage threshold for a model budget note; `off` disables it |
| `contextThresholds` | `"70,85"` | Context thresholds relative to the compaction window |

For example, keep warnings but disable background calls and hidden budget notes by
merging this into `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "budget-guard": { "keepalive": false, "budgetNudgeAt": "off" }
  }
}
```

## Behavior and limits

- The timer checks every 10 seconds. For a `5m` TTL, an automatic ping is sent
  **4:20–4:30 after the last request starts**, not after its response ends.
  Generation time, including the ping's own response, already consumes the TTL.
  If the safe window is missed (age above 285 seconds), the mod waits for a new
  main request instead of paying for a late warmup.
- There is no context-size threshold by default (`keepaliveMinTokens: "0"`). Set
  one explicitly if needed; a previously saved `"30000"` remains in effect.
- Keepalive skips in-flight main requests, contexts below the configured threshold,
  idle stretches beyond the configured horizon, and subscription usage at or above
  98%. The default horizon is 30 minutes after the last real request, not a ping.
- `/budget` shows the countdown, skip reason, last failure, and the pings' cache
  reads, writes, and output. Transient API errors that reported zero usage may be
  retried every 10 seconds, at most three attempts and only before the safe deadline.
  Other failures or responses without a majority cache hit pause pings until the
  next successful main request and raise a toast. The old cache timestamp is preserved,
  so the cold-cache guard keeps working.
- `neo-statusline` 0.2.1 and later observe confirmed fork cache hits too: their countdown
  refreshes and shows `↻`. A request merely being sent is not proof of a warm cache.
  Update and reload both installed mods; edits to a marketplace source directory alone
  do not replace the installed copies.
- A ping uses the same prefix and model settings through `$.model.fork` and asks
  for `ok`. The fork API does not expose `maxTokens`, so zero output is not
  guaranteed; both the short response and cache read consume usage.
- In `confirm` mode, a held prompt returns to the input. Submit the same text again
  within two minutes to proceed. Slash commands and programmatic/meta prompts bypass
  this check; changing the text requires a new confirmation.
- Rate-limit warnings are deduplicated across reloads through the plugin store.
  Thresholds of 90% and above also request a system notification.
- Context warnings suggest `/compact` or `/clear`; the mod does not run either.
- Cache age and the `/budget` counters are local estimates, not provider guarantees.
  A hot reload resets cache age and counters but preserves the session keepalive
  toggle. The mod does not inspect old transcripts.
- The high-usage model note is appended to the current prompt's context, not to the
  earlier conversation. No note is added when `budgetNudgeAt` is `off`.

## Check

From the repository root:

```sh
claude plugin validate ./budget-guard --profile directory
claude plugin test ./budget-guard
```

The tests mock the clock, store, and model fork; they do not send real model requests.

## License

[MIT](LICENSE) © 2026 Hoxiee. The icon uses the same license;
its editable source is [assets/icon.svg](assets/icon.svg).
