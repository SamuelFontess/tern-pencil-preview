# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
