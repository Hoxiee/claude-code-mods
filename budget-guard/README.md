# budget-guard

<img src=".claude-plugin/icon.png" alt="" width="80" height="80" align="right">

English | [Русский](README.ru.md)

Prompt-cache keepalive and budget warnings for Claude Code. The mod watches the main
thread's requests, subscription limits, and context size. Its commands and notifications
are currently in Russian.

- Keep a five-minute prompt cache warm during a short idle stretch.
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
| `/budget on` | Enable keepalive for the currently loaded mod |
| `/budget off` | Disable keepalive; warnings and the cold-cache guard stay active |

The command toggle is not a saved preference. Use `keepalive` in the mod's options
for a setting that survives reloads.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `keepalive` | `true` | Allow background keepalive requests |
| `keepaliveMinutes` | `"30"` | Idle horizon after the last real request |
| `keepaliveMinTokens` | `"30000"` | Minimum context size for keepalive |
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

- The timer checks every 15 seconds. A ping is allowed between 235 and 285 seconds
  after the last request, before the assumed five-minute cache expiry.
- Keepalive skips in-flight main requests, small contexts, idle stretches beyond
  the configured horizon, and subscription usage at or above 98%.
- In `confirm` mode, a held prompt returns to the input. Submit the same text again
  within two minutes to proceed. Slash commands and programmatic/meta prompts bypass
  this check; changing the text requires a new confirmation.
- Rate-limit warnings are deduplicated across reloads through the plugin store.
  Thresholds of 90% and above also request a system notification.
- Context warnings suggest `/compact` or `/clear`; the mod does not run either.
- Cache age and the `/budget` counters are local estimates, not provider guarantees.
  A hot reload resets in-memory tracking. The mod does not inspect old transcripts.
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
