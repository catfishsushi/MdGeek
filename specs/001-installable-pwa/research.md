# Research: Installable MdGeek (PWA)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-06

Each section records one decision, why it was made, and what else was considered.

## R1. What gets published

**Decision**: Publish the existing single-file browser build (`frontend/dist-web/index.html`) plus
four small files next to it: `manifest.webmanifest`, `sw.js` (the service worker), and two icons.
`npm run build:web` produces all of them in `dist-web/`.

**Rationale**: The single HTML file already holds the whole app (about 7.1 MB before compression,
much less after the host's gzip). A service worker that caches one HTML file plus four small files is
far simpler than one that tracks dozens of hashed script and style files. It also means there's one
browser build, not two, and that same `index.html` still works when opened straight from disk
(FR-010).

**Alternatives considered**:
- *A normal multi-file Vite build for the hosted version.* Smaller first download per file and better
  caching of unchanged parts between releases, but needs a second build mode and a generated list of
  files to cache. Not worth it for a single-user tool.
- *`vite-plugin-pwa` (built on Google's Workbox library).* The common choice for Vite apps; generates
  the manifest and service worker. Adds a dependency and a lot of config for what is about 50 lines
  of hand-written code here. Rejected per "simplest first".

## R2. Service worker: caching and updates

**Decision**: A hand-written `sw.js`, about 50 lines:
- On install, cache the five published files under a cache named `mdgeek-<version>`, where
  `<version>` is a short hash of `index.html` written into `sw.js` at build time.
- On activate, delete caches with any other name.
- On fetch, answer requests for those files from the cache first (works offline), falling back to
  the network.
- No `skipWaiting()` on install. A new version waits until every MdGeek window is closed, so it can
  never swap code under unsaved edits (FR-004, SC-005).

The page watches for a waiting new version and shows a toast: "A new version of MdGeek is ready.
Reload". Clicking Reload first saves all open files (the existing `flushAll`), then tells the
waiting service worker to take over, then reloads. If any save fails, it doesn't reload.

**Rationale**: The browser re-checks `sw.js` on each start while online and installs it if even one
byte changed. Putting the hash of `index.html` in `sw.js` makes every release change `sw.js`
automatically. Cache-first plus "wait until closed" is the standard "app shell" pattern and matches
the spec's "applied the next time MdGeek starts, or right away if they choose".

**Alternatives considered**:
- *Network-first.* Always newest when online, but slow on a bad connection and needs a timeout.
  The update toast gives the same result without the delay.
- *`skipWaiting()` plus automatic reload.* Simplest updates, but can reload with unsaved edits.
  Rejected by FR-004.

## R3. Making it installable

**Decision**: `manifest.webmanifest` with `name`, `short_name`, `start_url: "./"`, `scope: "./"`,
`display: "standalone"`, `background_color`, `theme_color`, icons at 192×192 and 512×512, plus
`file_handlers` (R4) and `launch_handler` (R4). `index.html` gets `<link rel="manifest">` and a
`theme-color` meta tag. All paths are relative, because GitHub Pages serves the site under
`/<repo-name>/`, not the site root.

Icons: `icon-192.png` and `icon-512.png` are made once from `build/appicon.png` (1024×1024) and
committed to `frontend/public-web/`. Resizing is a one-time step (any image editor, or PowerShell
with `System.Drawing`), not part of the build.

**Rationale**: Edge and Chrome offer to install a site that is served over HTTPS (or `localhost`),
has a manifest with a name, a start URL, `standalone` display and 192/512 icons, and registers a
service worker. The manifest is the standard, so there's nothing to choose here beyond the values.

## R4. Opening .md files from File Explorer

**Decision**: Use the manifest's `file_handlers` entry (`accept: { "text/markdown": [".md",
".markdown"] }`, `action: "./"`) and `launch_handler: { "client_mode": "focus-existing" }`. In
`web.ts`, `onOpenPaths` registers a consumer on `window.launchQueue`. Each launch passes
`FileSystemFileHandle`s, which go through the existing `register()` and then to the existing
`openPaths` in `main.ts`, the same path the desktop app's "Open with" uses.

Saving a file opened this way: the launch is not a click, so the browser may not have granted
write access yet, and asking needs a click. `writeFile` already calls `ensureWritable`; if that
fails for lack of a click, the page shows a banner, "MdGeek needs permission to save this file.
Allow", whose button asks again. Autosave retries after Allow.

**Rationale**: This is the only way a web app can receive files from the operating system. It's
supported in Edge and Chrome for installed apps on Windows. `focus-existing` sends a second opened
file to the window that's already open instead of starting a new one (Story 3, scenario 2).

**Risk to check during implementation**: whether Chrome grants write access to launched files
without a prompt. The banner handles both answers.

## R5. Remembering the left pane between sessions

**Decision**: Store the left pane's top-level items in IndexedDB, as an ordered list of
`{ name, handle }`. A small hand-written helper (`frontend/src/backend/handle-store.ts`, about 30
lines, no library) opens one database with one object store.

- The tree reports changes to its top-level list; the web backend saves it.
- On start, the web backend reads the list back, puts each handle into its `roots` map under its
  old name, and gives the list to the tree.
- A folder whose permission isn't granted shows collapsed in the list. Clicking it (or a file in
  it) asks for access, which counts as a click so the browser allows the prompt (FR-007).
- An item whose handle now fails with "not found" is dropped quietly (Story 4, scenario 2).

Edge and Chrome (version 122 and later) offer installed apps an "Allow on every visit" choice in
this prompt, after which no prompt appears at all.

**Rationale**: File and folder handles can be saved in IndexedDB but not in `localStorage`, which
only holds strings. A raw IndexedDB helper for one list is short.

**Alternatives considered**: the `idb-keyval` library (tiny and popular) would save about 20 lines
but adds a dependency for one key.

## R6. Hosting on GitHub Pages

**Decision**: A GitHub Actions workflow (`.github/workflows/pages.yml`) runs on each push to `main`:
`npm ci`, `npm run build:web` in `frontend/`, then publishes `frontend/dist-web/` with GitHub's
official `upload-pages-artifact` and `deploy-pages` actions.

**Rationale**: It's GitHub's own recommended way to publish a built site, and builds happen on
every merge with nothing to remember.

**Repo decision (2026-10-06)**: The repo will be public on GitHub (`catfishsushi/MdGeek`, not
created yet), which makes GitHub Pages free. Before the first push, scan the history for secrets,
since every past commit becomes public.

## R7. Security on a static host

**Decision**: Add a `Content-Security-Policy` `<meta>` tag to `index.html` in the web build:
`default-src 'self'; script-src 'self' 'sha256-<hash of the inlined script>'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none'`. The build computes the script hash after inlining.

**Rationale**: Your security defaults ask for security headers on every response, but GitHub Pages
can't set custom headers. A CSP `<meta>` tag is the part that can be done in the page itself. Two
limits to know:
- A `<meta>` CSP can't be "Report-Only", so it's enforced from day one. The quickstart includes a
  check that nothing is blocked (watch the DevTools console).
- `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and HSTS can't be set on GitHub
  Pages. Pages does force HTTPS. If those headers matter, Cloudflare Pages or Netlify can set them
  with a `_headers` file.

`style-src 'unsafe-inline'` is needed because CodeMirror and Milkdown set inline styles. Markdown
rendering is already sanitized with DOMPurify, so this doesn't open a script path.

## R8. Browsers that can't run MdGeek

**Decision**: On start, the web build checks for `window.showDirectoryPicker`. If it's missing
(Firefox, Safari), the empty-state area says "MdGeek needs Edge or Chrome on a computer" and the
Open buttons are disabled.

**Rationale**: The spec's edge case assumed this message already existed; it doesn't, so it's added
here. It's a few lines.

## R9. Testing

**Decision**: Manual checks from `quickstart.md`, run in Edge against `npm run preview:web` on
`localhost` and then against the GitHub Pages address. The project has no automated tests today, and
most of this feature (install prompts, File Explorer, offline) is browser and operating system
behavior that unit tests can't reach. The Playwright browser tools available in Claude Code can
check the parts that can be scripted: the manifest loads, the service worker registers, the page
loads offline.
