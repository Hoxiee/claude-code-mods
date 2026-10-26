# neo-statusline

<img src=".claude-plugin/icon.png" alt="" width="80" height="80" align="right">

English | [Русский](README.ru.md)

A one-line status bar for Claude Code, drawn under the prompt:

```
● ◆ Sonnet 5.5:xhi │ ◇ main ~2 +1 ↑1 │ ctx ████░░░░ 13% 127k/1M │ cache 99% Σ98% 1h 42m → 20:45 │ 5h 21% (4h17m) │ 7d 7% (6d17h) │ $1.20 │ up 19m
```

![neo-statusline in Claude Code](docs/statusline.png)

*A capture from a live session, right after its second request: the prefix is read back in full (`100%`), the session total is `Σ86%`, the cache lives for one hour.*

| Segment | Shows |
| --- | --- |
| `●` / `◉` | idle / a turn is running |
| `◆ Sonnet 5.5:xhi` | model and thinking effort (`lo`, `md`, `hi`, `xhi`, `max`) |
| `◇ main ~2 +1 ↑1` | branch; `~` modified, `+` added, `-` deleted, `→` renamed, `?` untracked, `!` conflicts, `↑`/`↓` ahead/behind, `✓` clean |
| `ctx` | context window fill, with a bar and token counts |
| `cache` | prompt cache of this session: the last request's hit ratio, `Σ` the whole session's, `+Nk` written by the last request, `miss` when it lost the cached prefix, the lifetime (`5m` / `1h`), time left and the moment it goes cold |
| `5h`, `7d` | rate-limit windows and time until reset |
| `agents 1/3` | subagents running over all started this session |
| `$` | session cost |
| `up` | session length |

Bars and percentages turn yellow, orange and red as they fill (50 / 65 / 80%). The line
drops detail on narrow terminals. The engine's own hint line stays beneath it, minus the
`(shift+tab to cycle)` and `N agents` reminders.

## Subagents

Open a subagent from the tasks list and the bar switches to it, drawn from that agent's own
requests (back in the main conversation it returns to the usual one):

```
◉ ⤷ Explore Scan the repo │ ◆ Haiku 5.5:hi │ ctx 33k │ cache 91% Σ47% +30k 1h 58m → 21:40 │ tok ↑2k in 2k cw 32k cr 30k │ 2 req │ session $1.20
```

| Segment | Shows |
| --- | --- |
| `◉` `●` `✓` `✗` | agent state: running, idle, completed, failed or killed |
| `⤷ Explore Scan the repo` | its type and task description |
| `◆ Haiku 5.5:hi` | the agent's own model and effort, which may differ from the main one |
| `ctx` | tokens in its window now; with a bar and percent when it runs on the main model |
| `cache` | its own cache, read the same way as the main one (last request, `Σ`, `+Nk`, `miss`, countdown) |
| `tok` | everything it was billed for: `↑` output, `in` uncached input, `cw` cache written, `cr` cache read |
| `req` | requests it made |
| `session` | the session's cost: the engine keeps no per-agent ledger |

An agent that made no request since the mod loaded shows `no requests seen yet`. Each
agent's numbers are kept with its session, like the main cache's.

## Install

At the Claude Code prompt:

```text
/plugin install neo-statusline --marketplace Hoxiee/claude-code-mods
```

Confirm adding the marketplace with `y`, then choose the installation scope and options.

The mod draws the `PromptHint` component, so it needs a terminal Claude Code with mods.
Add the mod folder to `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/neocc-mods/neo-statusline" },
  "pluginConfigs": { "neo-statusline": { "cacheTtl": "1h" } }
}
```

## Options

`cacheTtl`: lifetime of the prompt cache. The engine does not report it, so `auto` (the
default) infers it from cache hits after a pause longer than five minutes and shows
`5m?` until it has proof. Set `5m` or `1h` to fix it.

`showLimits` (checkbox, on by default): show the `5h` / `7d` subscription limit windows.
Turn it off if another tool, such as a bar, already shows them. A gateway `spend` limit is
not affected.

## Cache numbers

The ratio is `read / (read + written + uncached)` of the **last request**, not of the whole
turn: a turn sums all its requests, which hides what the cache is doing right now. `Σ` sums
every request of the session. Each session keeps its own numbers, so a new session or a
`/clear` starts from `cache —` instead of showing another session's countdown. Subagent
requests are not counted in it: they have a cache of their own, shown when you view the agent.

A lower ratio right after a long tool result is normal (`+Nk` is the new text being
cached); `miss` is the real failure, and means the previous prefix was not read back.

For the full picture of a session, `tools/ccache` reads its transcript:

```sh
ln -s "$PWD/tools/ccache" ~/.local/bin/ccache
ccache            # the newest session of the current directory
ccache 82045d4f   # a session id prefix
```

It lists every API call (new / written / read tokens), marks `CACHE BREAK` and `COLD`
requests, and prints the session ratio and when the cache expires.

## Check

```sh
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE) © 2026 Hoxiee. The icon uses the same license;
its editable source is [assets/icon.svg](assets/icon.svg).
