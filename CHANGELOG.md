# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.5.0] - 2026-10-27

0.5.0 replaces the static "Pencil Preview" block with an editor on a Tern whiteboard. Opening a `.pen` file starts a
headless Pen engine for that document and opens a board beside your pane with every top-level frame as an image,
placed like the Pencil canvas. You edit on the board itself, and an agent can edit the same open document through its
own MCP endpoint. The read-only "Open Pencil board (live mirror)" command from 0.4 is unchanged.

### Upgrading

- Update with `tern plugin install --force github.com/SamuelFontess/tern-pencil-preview` (without `--force` Tern
  refuses, because the plugin is already installed). The plugins reload by themselves when Tern is open.
- The plugin's data, everything under `~/.pencil` and your `.pen` files are kept.
- A pane of the 0.4 "Pencil Preview" block, open during the update or restored from a workspace saved under 0.4, now
  shows a notice: the preview was replaced by the editor, the name of the file it had, and how to open it ("Open Pencil
  editor" in the palette, or the `.pen` from the Files pane). The notice reads and starts nothing; close the pane.

### Added

- The editor: a plain open of a `.pen` from the Files pane or the palette, or the command "Open Pencil editor", starts
  a dedicated headless Pen engine for that document and opens its whiteboard beside the pane you are in.
  A line at the top of the board shows the document's state, its render and whether there are unsaved edits.
- Editing on the board, applied to the document's own history as you go (no Apply button):
  - Select like a design tool: a click picks the outer element, a double click on a container goes into it, and a
    click outside it (or Esc with an element of it selected) goes back up a level.
  - Move and resize: a free element takes its new position and fixed size. A value the document does not leave to
    the board (set by an auto-layout parent, automatic or inherited size, a hidden, clipped, rotated or scaled
    element) goes back, with a notice that says why.
  - Reorder: drop an auto-layout child elsewhere along its parent's axis to move it to that place in the same
    parent.
  - Text: double-click a text to edit it on the board. Enter breaks the line; a click outside finishes the edit. Text
    bound to a variable, inside a component instance or over 1000 characters is not editable. If an agent changed the
    same text meanwhile, the board asks which text to keep.
- Palette commands "Pencil: Save", "Pencil: Undo" and "Pencil: Redo" for the focused (or only) editor, and "Reopen
  Pencil editor board" for a session still running without its board.
- Agents: each open document has a local MCP endpoint working on the same history. "Pencil: Copy MCP configuration"
  copies the `mcpServers` entry for it; no setting of yours is changed. An invalid change fails with
  `OPERATIONS_REJECTED` and the engine's reason, and the session goes on.
- Closing a board with unsaved edits asks Save / Discard / Back; without edits the editor just ends. A save refused
  because the file changed on disk offers a recovery copy.
- Your edits survive a crash: unsaved edits stay in the editor's history (the `.pen` is never written without Save),
  and the next opening offers to restore them or use the file on disk.
- An editor whose window is gone ends by itself after 2 minutes. Opening the same file before then reconnects to it,
  and so does a window after a plugin reload. One window at a time drives an editor; another one is told it is
  shown elsewhere.
- An editor that cannot start (the file is open in another editor, it changed while opening, the engine did not start,
  Node is missing) says why at once.

### Changed

- `.pen` opens go to the editor instead of the static preview block, under the same "Toggle Pencil Preview for .pen
  opens" setting and the same routing rules.
- The plugin loads its modules one per tick, so a busy machine keeps it inside Tern's 50 ms budget. If Tern switches
  off the plugin's timers anyway, an open in progress carries on by itself and the plugin tells you once to run
  **Reload plugins**.

### Removed

- The static "Pencil Preview" block: frame browsing, layers, the inspector with its keyboard navigation, live mode,
  and "Open with › Pencil Preview". The editor replaces it, with the same read access plus editing. Only the notice
  for old panes remains under that name, with no palette entry.

### Fixed

- "Open Pencil board (live mirror)" no longer does nothing, without a word, when Tern switched off the plugin's
  timers while it loaded: it says to reload plugins.

### Known limitations

- A slow drag can bounce back before you release it: the board takes a pause in the drag for its end. Drag in one
  motion. A fix is planned for 0.5.1.
- Esc goes up a level only when an element is selected (right after going in, or after an edit, nothing is). A click
  outside the container always works.
- On an overloaded machine Tern can still switch off the plugin's timers (a callback over its 50 ms budget). The plugin
  says so and an open in progress carries on, but run **Reload plugins** from the palette to get the timers back.
  Nothing reloads automatically. If Tern switches off the plugin's `await` hook as well, nothing carries on until you
  reload plugins.
- On Tern 0.9.5, `tern open design.pen` typed in a terminal does not reach the plugin (Tern answers "cannot open in a
  file block"). Open the file from the Files pane or the palette, or run "Open Pencil editor".

## [0.4.1] - 2026-10-23

### Fixed

- The window half could exceed Tern's 50 ms hook budget while loading on every reload and on a cold start, with the
  require chain `window.luau` → `board.luau` → `lib/cache`, `lib/launch`, `lib/mirror`, `lib/script`, `lib/util` all
  run inside the `load` hook. Tern then disabled the window half until a reload, so `.pen` opens went to the editor
  and both "Open Pencil board (live mirror)" and "Toggle Pencil Preview for .pen opens" were missing from the
  palette. The board's `lib/` chain, and `board.luau` itself, now load one module per timer tick, and only the
  first time "Open Pencil board (live mirror)" runs; the `load` hook itself only registers routing and commands.
  Reported in #1.

## [0.4.0] - 2026-10-16

### Added

- The board: the command "Open Pencil board (live mirror)" opens a Tern whiteboard with every top-level frame of a
  `.pen` as an image, placed like the Pencil canvas, and keeps it up to date with the file's unsaved edits from the
  Pencil app (changes made in Pencil or by an agent appear a few seconds after Pencil writes its backup). Pen
  exports only the frames whose content changed, as PNG at scale 1, and the board swaps just those images. It is
  read-only: nothing drawn on the board reaches Pencil or the file. Verified on Windows with Pencil 1.2.15.

### Changed

- `cache.shared_seed` is split out of `cache.frame_keys` (same keys).

## [0.3.1] - 2026-10-15

### Fixed

- A top-level frame without a fixed size keeps its image in the render cache: it no longer renders again on every
  new version of the file or when the file is reopened, while the frame itself is unchanged.

## [0.3.0] - 2026-10-15

### Added

- Live mode: while the file has unsaved edits in the Pencil app, the block shows them (dock: `Live · unsaved`)
  by reading the backup Pencil writes every few seconds. No process runs while nothing changes. `v` turns it off
  and on.

### Changed

- A new version renders only the top-level frames that changed; the others reuse their image from the cache.
  Editing a variable or a reusable component renders every frame. The render cache is rebuilt once.

## [0.2.0] - 2026-10-14

### Changed

- One `pen` run per file version exports every top-level frame, the selected
  one first, as JPEG (PNG for frames without a background) into a render cache
  in the plugin data folder; switching frames reads the cache and starts no
  process. A 17-frame file renders in about 7 s.
- The cache survives block, plugin and Tern restarts. It keeps the 2 latest
  versions of each file and at most 200 MB.
- A changed file renders once it holds still for one poll (2 s).
- Batch renders time out after 120 s.
- Frames without a fixed size and other top-level nodes render one per run when
  selected.

### Fixed

- Switching frames no longer shows the previous frame's image under the new
  frame's name.
- Frames with a stroke no longer export past 4096 px a side; one that still
  does is exported again at a lower scale.
- Export folders of closed blocks no longer stay in the plugin data folder.

## [0.1.0] - 2026-10-14

### Added

- Native Tern block `Pencil Preview` that previews a `.pen` design: the
  selected top-level frame as an image, a layer list and an inspector.
- Rendering through the headless `pen interactive` CLI; exports go to the
  plugin data folder (scale up to 2, at most 4096 px a side) and the `.pen`
  file is never written.
- Automatic re-render when the file changes (polled every 2 s).
- Frame switching, layer selection, pause, manual re-render, copy of the
  layer id, and opening the file in the system app or in the editor.
- Routing of `.pen` opens from the Files pane, the palette and `tern open` to
  the preview, plus the command "Toggle Pencil Preview for .pen opens".
- `TERN_PENCIL_CLI` to point the plugin at `pen`, `pen.cmd`, `pen.exe` or the
  CLI's `index.mjs`.
- Problem cards or dock notices for a missing CLI, failed or timed-out renders
  and unreadable files.
- Dock notice with an error toast when a render fails while an image is shown.
- Local gate (`scripts/gate.py`): type check plus unit tests.
