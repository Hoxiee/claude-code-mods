# neo-statusline

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
| `$` | session cost |
| `up` | session length |

Bars and percentages turn yellow, orange and red as they fill (50 / 65 / 80%). The line
drops detail on narrow terminals. The engine's own hint line stays beneath it, minus the
`(shift+tab to cycle)` and `N agents` reminders.

## Install

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
requests are not counted: they have a cache of their own.

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
