# Quickstart: Build, Run, and Check the Installable MdGeek

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-06

## Build and run locally

```powershell
cd C:\DevProjects\MdGeek\frontend
npm run build:web      # writes dist-web/: index.html, sw.js, manifest.webmanifest, icons
npm run preview:web    # serves dist-web/ at http://localhost:4173
```

Open `http://localhost:4173` in Edge. `localhost` counts as secure, so install and offline both
work without HTTPS.

To start fresh between checks: DevTools > Application > Storage > "Clear site data", and uninstall
MdGeek from `edge://apps`.

## Checks

Each check maps to a user story or requirement in the spec.

### 1. Install (Story 1, FR-001, FR-002)
- DevTools > Application > Manifest shows no errors, and the MdGeek icon appears.
- The install icon shows in the address bar. Install, close Edge, start MdGeek from the Start menu:
  own window, MdGeek title and icon, no address bar.
- Open a folder, edit and save a file, switch WYSIWYG/Source, change theme, Ctrl+Click a link, drop
  a file on the left pane. All work as in the browser tab (FR-008).

### 2. Offline (Story 2, FR-003)
- After one online load, stop `npm run preview:web` (or DevTools > Network > Offline).
- Start MdGeek from the Start menu. It loads; open, edit, and save work. Time from start to an open
  file is under 3 seconds (SC-002).

### 3. Update without losing edits (Story 2, FR-004, SC-005)
- With MdGeek open, make an edit and don't wait for autosave.
- Change any text in the app, run `npm run build:web` again, restart the preview server, then focus
  MdGeek and reload once (or wait for the browser's next update check).
- The toast "A new version of MdGeek is ready" appears; nothing reloads by itself.
- Click Reload: the edit is saved to disk first, then the app reloads with the new text.

### 4. Open from File Explorer (Story 3, FR-005)
- Right-click a `.md` file > Open with > MdGeek. It opens and is listed in the left pane.
- With MdGeek open, open a second `.md` file the same way: it opens in the same window.
- Edit and save the file. If a "needs permission to save" banner appears, click Allow and confirm
  the save lands on disk.
- When Edge asks whether MdGeek may open this file type, decline once: MdGeek opens with no file
  and no error.

### 5. Reopen last session (Story 4, FR-006, FR-007)
- Open a folder and drop one extra file on the left pane. Close MdGeek and start it again.
- Both items are listed. No prompt appears until you click into one, and then at most one
  (SC-004). Choosing "Allow on every visit" makes later starts prompt-free.
- Rename the folder in File Explorer, restart MdGeek: it's quietly gone from the list.

### 6. Fallbacks (FR-009, FR-010, edge cases)
- Use MdGeek in a normal Edge tab without installing: everything in check 1 works.
- Open `dist-web\index.html` directly by double-clicking: the app runs as before; DevTools shows no
  service worker registered.
- Open the address in Firefox: the "needs Edge or Chrome" message shows and the Open buttons are
  disabled.
- Build and run the desktop app (`wails build`): no change in behavior.

### 7. Security (R7)
- DevTools console shows no Content-Security-Policy errors while doing checks 1 to 5.
- DevTools > Network: no request carries file contents or names anywhere (FR-012).

## Publish (after merge to main)

Pushing to `main` runs `.github/workflows/pages.yml`, which builds and publishes `dist-web/` to
GitHub Pages. Repeat checks 1 to 4 against the Pages address once it's live.
