# neocc-mods

English | [Русский](README.ru.md)

A collection of mods for Claude Code. Each mod lives in its own folder and is a
self-contained plugin (`.claude-plugin/plugin.json` plus a hooks module).

| Mod | What it does |
| --- | --- |
| [`neo-statusline`](./neo-statusline) | One-line status bar under the prompt: model, thinking effort, git, context, prompt cache, rate limits, cost |

## Using a mod

Point `CLAUDE_CODE_PLUGIN_DIRS` at the mod folder in `~/.claude/settings.json`. The folder is
watched, so edits reload the mod while a session is running.

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/neocc-mods/neo-statusline" }
}
```

Several mods: separate the paths with `:` on Linux and macOS.

## Checking a mod

```sh
claude plugin validate ./neo-statusline
claude plugin test ./neo-statusline
```
