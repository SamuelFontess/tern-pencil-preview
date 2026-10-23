# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
