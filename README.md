# tern-pencil-preview

Previews pen.dev (Pencil) `.pen` designs in a native Tern block: the selected top-level frame (switch with Left/Right) as an image, its layers and an inspector, re-rendered when the file changes.

## Requirements

- Tern with plugin support (built against 0.8.3).
- The pen.dev CLI (`npm install -g @pen.dev/cli`; the pen.dev CLI requires Node 22.19 or later), signed in with `pen login`. Exports require an authenticated CLI.

Verified on Windows. On macOS and Linux the plugin runs `pen` from `PATH`; this is not verified yet.

## Install

```
tern plugin install github.com/SamuelFontess/tern-pencil-preview
```

For development, link a checkout instead:

```
tern plugin link <dir>
```

## Usage

- `tern open design.pen` (any placement).
- Open a `.pen` file from the Files pane or the palette.
- "Open with › Pencil Preview" on a file.

The command "Toggle Pencil Preview for .pen opens" switches the routing. When it is off, the Files pane, the palette and `tern open` use the editor; "Open with" still works. The setting is shared by all windows.

Routing details: from the Files pane and the palette only a plain open is routed to the preview (an open with a placement goes to the editor); `tern open` is routed with any placement. Any open that asks for a line goes to the editor.

### Keys

| Key | Action |
| --- | --- |
| `Left` / `[` | Previous frame |
| `Right` / `]` | Next frame |
| `l` | Show or hide the layers and inspector panel |
| `Up` / `k` | Previous layer (panel open) |
| `Down` / `j` | Next layer (panel open) |
| `y` | Copy the selected layer id |
| `r` | Render again (queued if a render is running) |
| `Space` | Pause or resume watching the file |
| `p` | Open the file in the system app |
| `o` | Open the file in the editor |

Keys with Ctrl, Alt or Meta are not handled by the block. Clicking a layer in the list selects it. The chosen frame, selected layer, panel and pause state are restored when the block restarts.

## How it works

The block polls the file every 2 s. When the content or the chosen frame changes, it runs `pen interactive` headless with a snippet that walks the document and exports the selected frame (scale up to 2, at most 4096 px a side) into the plugin data folder. The `.pen` file is never written. Each render takes a few seconds because of the headless start-up. Closing the block removes its exported images and scratch file.

## Configuration

`TERN_PENCIL_CLI`: path to `pen`, `pen.cmd`, `pen.exe` or the CLI's `index.mjs`. Needed when Tern was started without the npm global bin directory on `PATH`.

## Errors

- With no image yet, a failure shows as a card with the tail of the CLI output and Render / Open in Pencil buttons; the card shows "Rendering …" while a render runs. With an image already shown, the image stays and a notice appears in the dock; an error toast also appears when the notice first appears.
- A failed render is not retried until the file or the frame changes, or you press `r`. Pressing `r` while a render runs queues another render, also while paused.
- A timeout (60 s) is retried on the next poll.
- The render-failure card suggests running `pen login`.
- The missing-CLI card names `TERN_PENCIL_CLI`.

## Limitations

- Shows the saved file, not unsaved edits in the Pencil app.
- Top-level frames only.
- The layer tree is read to depth 6.
- `.pen` files over 16 MiB are refused.
- No editing.

## Development

```
python scripts/gate.py
```

The gate type-checks every non-test `.luau` file with `luau-lsp` and runs `luau tests/run.luau`. It needs `luau` and `luau-lsp`; `LUAU_TOOLS` sets their folder.

Layout:

- `plugin.toml`, `host.luau` (the `preview` block), `window.luau` (open routing and the toggle command).
- `lib/`: `doc.luau` (parses the render summary), `launch.luau` (finds the pen CLI and the OS opener), `script.luau` (builds the snippet sent to `pen interactive`), `util.luau` (paths and frame/layer helpers), `view.luau` (block view).
- `tests/`: `*_test.luau` unit tests registered in `run.luau`, the `tern` stub in `stub.luau`, and `fixtures/`.

## License

MIT. See [LICENSE](LICENSE).
