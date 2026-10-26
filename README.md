# neocc-mods

<img src="assets/icon.png" alt="" width="96" height="96" align="right">

English | [Русский](README.ru.md)

A collection of mods for Claude Code. Each mod lives in its own folder and is a
self-contained plugin (`.claude-plugin/plugin.json` plus a hooks module).

| Mod | What it does |
| --- | --- |
| <img src="neo-statusline/.claude-plugin/icon.png" alt="" width="24" height="24"> [`neo-statusline`](./neo-statusline) | One-line status bar under the prompt: model, thinking effort, git, context, prompt cache, rate limits, cost |
| <img src="neo-screenshots/.claude-plugin/icon.png" alt="" width="24" height="24"> [`neo-screenshots`](./neo-screenshots) | Searchable history of images from Read and MCP tools; open saved snapshots in the system viewer |
| <img src="budget-guard/.claude-plugin/icon.png" alt="" width="24" height="24"> [`budget-guard`](./budget-guard) | Prompt-cache keepalive, subscription and context warnings, and confirmation before a cold-cache request |

## Install

At the Claude Code prompt, choose the mod you want:

```text
/plugin install neo-statusline --marketplace Hoxiee/claude-code-mods
/plugin install neo-screenshots --marketplace Hoxiee/claude-code-mods
/plugin install budget-guard --marketplace Hoxiee/claude-code-mods
```

Confirm adding the marketplace with `y`, then choose the installation scope and options.
See each mod's README for its requirements and controls. `budget-guard` makes background
model requests when keepalive is enabled; these consume usage.

## Using a local copy

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
claude plugin validate ./neo-statusline --profile directory
claude plugin test ./neo-statusline
```

Replace `neo-statusline` with another mod's folder to check it. `neo-screenshots` also
has Python tests; see its README.

## License

[MIT](LICENSE) © 2026 Hoxiee. Each mod includes its own copy of the license.
The collection icon and all mod icons use the same license; their editable sources
are in the corresponding `assets/icon.svg` files.
