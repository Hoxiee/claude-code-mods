# neo-screenshots

<img src=".claude-plugin/icon.png" alt="" width="80" height="80" align="right">

English | [Русский](README.ru.md)

A searchable side panel for images read by Claude Code through `Read` and MCP tools,
including subagent calls. Click a filename to open the saved snapshot in your system
image viewer. No inline thumbnails, image conversion, or extra model calls.

Each entry shows its filename, stable snapshot number, capture time, source tool, and
original path when available. New snapshots appear first. The interface labels are
currently in Russian.

## Install

Requires Claude Code with support for hooks modules, a local Linux graphical session,
`python3`, and `xdg-open` from `xdg-utils`. ImageMagick and terminal graphics protocols
are not needed.

At the Claude Code prompt:

```text
/plugin install neo-screenshots --marketplace Hoxiee/claude-code-mods
```

Confirm adding the marketplace with `y`, then choose the installation scope and options.

Or from a shell:

```sh
claude plugin install neo-screenshots --marketplace Hoxiee/claude-code-mods
```

### Local development

Start a session with the mod from your checkout:

```sh
claude --plugin-dir /path/to/neocc-mods/neo-screenshots
```

For hot reload, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in
`~/.claude/settings.json`. Separate multiple paths with `:` on Linux and macOS; keep
any mod paths you already use.

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/neocc-mods/neo-screenshots" }
}
```

## Use

| Command or key | Action |
| --- | --- |
| `/screenshots` | Open and focus the panel |
| `/screenshots clear` | Clear the list and search without changing source files |
| Click a filename / `Enter` | Open the selected snapshot in the system viewer |
| `Tab` | Move between the search field, entries, and buttons |
| `1`–`9` | Open that row of the current page while the panel has focus, outside the search field |

Search matches the filename, original path, source, and image format without regard
to case. Every word must match. `Сбросить поиск` clears the filter; `Очистить список`
clears the whole list and search.

The page size follows the panel height, up to nine snapshots. `Новее` and `Старее`
move between newer and older pages. Snapshot numbers stay the same when filtering
or changing pages; number keys refer to the visible rows, not those snapshot numbers.

In the fullscreen terminal interface, the panel docks to the side from 110 columns.
An automatic opening requires 144 columns. `/screenshots` also works in a narrow
terminal, where the client places the panel above the input.

## Options

`autoOpen` (checkbox, on by default): open the panel after the first captured image
when the terminal is wide enough. A panel closed manually does not reopen itself.
Turn the option off to open the list only with `/screenshots`:

```json
{
  "pluginConfigs": { "neo-screenshots": { "autoOpen": false } }
}
```

This is a setting in `~/.claude/settings.json`; merge it with your existing configuration.

## System viewer

The viewer receives the exact image bytes returned by the tool. `Read` may resize an
image before sending it to the model; that returned version is the one saved here.
Overwriting the source file does not change an existing snapshot.

The viewer runs separately, so its window does not hold the hook open. `xdg-open`
uses your desktop's existing file associations without changing them. In an SSH or
headless session, opening a snapshot still needs a graphical environment on the
machine running the client.

## Data and limits

- Collection starts when the mod is enabled; earlier history is not scanned.
- PNG, JPEG, GIF, and WebP from successful `Read` results and MCP image blocks are
  supported. Images attached directly to a prompt and PDF pages are not collected.
- Re-delivery of the same tool result does not create a duplicate. Reading the same
  path again creates a separate snapshot with its own number and capture time.
- The list survives hot reload and resets when the session changes or after `/clear`.
  Snapshots from the earlier thumbnail version remain accessible, though their
  original paths may be unknown; old thumbnail pixels are removed from state.
- Snapshots live in separate private `neo-screenshots-*` directories in the system
  temporary directory, usually `/tmp`, with directory/file permissions of 0700/0600.
  Clearing the list or ending a session does **not** delete these files: an open viewer
  may still need them. They remain until the system or the owner removes them.
- The mod does not send images over the network, add them to the model context, make
  extra model calls, or modify source files. Each snapshot is limited to 32 MiB.

## Check

From the repository root:

```sh
claude plugin validate ./neo-screenshots
claude plugin test ./neo-screenshots
python3 -I ./neo-screenshots/scripts/test_image_cache.py
```

After the client loads the mod, it generates `.claude-plugin/types/`. Type-checking
is then available with `tsc -p ./neo-screenshots`. Generated types and Python bytecode
are excluded from git.

## License

[MIT](LICENSE) © 2026 Hoxiee. The icon is included under the same license;
its editable source is [assets/icon.svg](assets/icon.svg).
