# neo-statusline

English | [Русский](README.ru.md)

A one-line status bar for Claude Code, drawn under the prompt:

```
● ◆ Sonnet 5.5:xhi │ ◇ main ~2 +1 ↑1 │ ctx ████░░░░ 13% 127k/1M │ cache 99% 1h 42m → 20:45 │ 5h 21% (4h17m) │ 7d 7% (6d17h) │ $1.20 │ up 19m
```

| Segment | Shows |
| --- | --- |
| `●` / `◉` | idle / a turn is running |
| `◆ Sonnet 5.5:xhi` | model and thinking effort (`lo`, `md`, `hi`, `xhi`, `max`) |
| `◇ main ~2 +1 ↑1` | branch; `~` modified, `+` added, `-` deleted, `→` renamed, `?` untracked, `!` conflicts, `↑`/`↓` ahead/behind, `✓` clean |
| `ctx` | context window fill, with a bar and token counts |
| `cache` | prompt cache hit ratio, its lifetime (`5m` / `1h`), time left and the moment it goes cold |
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

## Check

```sh
claude plugin validate .
claude plugin test .
```
