# MdGeek Requirements

A desktop app for viewing and editing Markdown (.md) files on Windows and Linux.

## Technology

- Wails v2 (Go backend, web frontend shown in the OS's built-in web view)
- Frontend: TypeScript with Vite, no UI framework
- Source editor: CodeMirror 6
- WYSIWYG editor: Milkdown Crepe (chosen)

## Must have

### Files and opening
- Open a file from the OS: right-click a `.md` file, then "Open with" MdGeek.
  - Windows: file path arrives as a command-line argument; installer registers `.md`.
  - Linux: `.desktop` file declaring `text/markdown`.
- Single instance: opening a second file sends it to the running window as a new tab.
- Open a file or folder from inside the app, and by drag and drop.

### Tabs
- Multiple files open at once, one tab each.
- Tabs can be closed and reordered.

### Sidebar file tree
- Shows the opened folder with its subfolders and `.md` files.
- Click a file to open it in a tab.

### Editing
- Two views per file: WYSIWYG and source. One at a time, toggled by the user.
- Switching views keeps the cursor position and scroll position where possible.
- Autosave: changes are saved automatically a short time after typing stops.
- Saving must not rewrite parts of the file the user did not touch (spacing, list markers). Test round-trips on real files early.

### Conflicts with outside changes
- Watch open files for changes made outside the app (for example, by another editor).
- If a file changed on disk and the tab has edits not yet saved, alert the user instead of overwriting either version.
- Where possible, offer a side-by-side diff of the two versions so the user can review before choosing: keep mine, take theirs, or (ideally) merge.
- Autosave pauses for that tab until the conflict is resolved.

### Markdown support
- GitHub Flavored Markdown: tables, task lists, strikethrough, autolinks.
- Images (relative paths resolved against the file's folder, plus web URLs).
- Syntax highlighting in fenced code blocks.
- Rendered HTML is sanitized so a hostile `.md` file cannot run scripts.

### Appearance
- Themes: at least light and dark, with an option to follow the OS setting.

### Export
- Export to HTML.
- Export to PDF.

## Not now

- Diagrams (Mermaid and similar).
- Search (within a file or across a folder).

## Open questions

- Recent files list and remembering open tabs between sessions?
- Does autosave overwrite the file silently, or keep a backup/undo history?
- Which Linux packaging: AppImage, .deb, or both?

## Status (updated 2026-10-06)

### Done
- First version built and committed (git commit `2240369`): tabs, file tree, WYSIWYG and source views,
  autosave, conflict banner with diff, themes, HTML/PDF export, single-instance "open in new tab".
- Smoke-tested on Windows: opening a file, tabs, tree, GFM/code/table rendering, second launch opening a
  tab, closing the window.
- Windows installer built and tested: `build/bin/MdGeek-amd64-installer.exe`. Registers `.md` and
  `.markdown` for "Open with". Config is in `wails.json` (`info` section).
- Hand-tested on Windows (2026-10-06): installer, "Open with", and the features listed as untested
  in the first build.

### Next steps
- Feature work is tracked in `backlog.md`.
- Linux: a `.desktop` file with `text/markdown`, packaging (AppImage and/or .deb), and a test build.

### Known gaps
- Switching tabs or views recreates the editor, so undo history does not survive a switch.
- The conflict dialog offers keep mine / take disk, not a line-by-line merge.
- Exported HTML keeps image paths as written, so images only show if it is saved next to them.
- The file tree does not notice new files until refreshed.
- `npm audit` reports 4 low-severity issues in Milkdown's LaTeX dependency, a feature that is turned off.

### How to build
- Needs Go, Node, and the Wails CLI (`C:\Users\Ted\go\bin\wails.exe`, not on PATH).
- NSIS is installed at `C:\Program Files (x86)\NSIS`; add it to PATH for the installer build.
- Build: `wails build` (exe only) or `wails build -nsis` (exe plus installer).
- If the build fails with "memory allocation ... failed", the PC is low on memory; close apps and retry.
