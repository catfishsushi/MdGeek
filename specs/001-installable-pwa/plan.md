# Implementation Plan: Installable MdGeek (Progressive Web App)

**Branch**: `001-installable-pwa` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-installable-pwa/spec.md`

## Summary

Turn the existing single-file browser build into an installable app that works offline, opens `.md`
files from File Explorer, and remembers the left pane between sessions, published to GitHub Pages.

The approach adds four small files next to the existing `dist-web/index.html` (a manifest, a
hand-written service worker, two icons), a little code in the web backend for the service worker,
file launches, and remembered handles, and a GitHub Actions workflow to publish. No new runtime
libraries. The desktop app and the single-file build keep working unchanged. Details and the reasons
for each choice are in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.6 (frontend), Go (desktop shell, not touched)
**Primary Dependencies**: Vite 7, `vite-plugin-singlefile` (existing). No new runtime dependencies.
**Storage**: IndexedDB for remembered file and folder handles; Cache Storage for the app's own
files; `localStorage` for settings (existing)
**Testing**: Manual checks in [quickstart.md](./quickstart.md); Playwright browser tools for the
scriptable parts (manifest, service worker, offline load). No test framework exists in the repo.
**Target Platform**: Edge and Chrome on Windows (installed web app and browser tab); the Wails
desktop app on Windows is unchanged
**Project Type**: Desktop app (Wails) with a browser build; this feature extends the browser build
**Performance Goals**: Offline start to an open file under 3 s (SC-002); File Explorer open under
3 s (SC-003)
**Constraints**: Must work offline after one visit; no reload while edits are unsaved; served from a
static host under a sub-path (`/<repo>/`), so all URLs relative; GitHub Pages can't set response
headers
**Scale/Scope**: One user per install; about 5 new files and edits to about 6 existing ones

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the blank template, so it sets no gates. This plan is
checked against your global CLAUDE.md rules instead:

| Rule                                      | Status | Notes                                                                                                 |
|-------------------------------------------|--------|-------------------------------------------------------------------------------------------------------|
| Simplest implementation first             | Pass   | Hand-written service worker and IndexedDB helper instead of Workbox / `idb-keyval` (R1, R5).          |
| Surface standard patterns before building | Pass   | App-shell caching, "update ready, reload" toast, File Handling API, persistent permissions (R2, R4, R5). |
| Security headers on every response        | Partial | GitHub Pages can't set headers. CSP added as a `<meta>` tag; the rest need a different host (R7).    |
| Validate input / sanitize HTML            | Pass   | No new input paths. Markdown rendering already goes through DOMPurify.                               |
| Never commit secrets                      | Pass   | No secrets involved.                                                                                  |
| Bot protection, authorization             | N/A    | No forms, accounts, or server.                                                                        |

**Post-design re-check**: Same results. The one partial item is recorded under Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-installable-pwa/
├── plan.md              # This file
├── research.md          # Decisions R1–R9
├── data-model.md        # Remembered item, app version
├── quickstart.md        # Build, run, and manual checks
├── contracts/
│   ├── manifest.md      # The web app manifest
│   └── service-worker.md# Service worker behavior, update flow, Backend interface additions
├── checklists/
│   └── requirements.md
└── tasks.md             # Made by /speckit-tasks
```

### Source Code (repository root)

```text
frontend/
├── index.html                  # + <link rel="manifest">, theme-color meta
├── package.json                # + "preview:web" script
├── vite.config.ts              # web mode: copy public-web/, write sw.js version, add CSP meta
├── public-web/                 # NEW: copied into dist-web/ by the web build only
│   ├── manifest.webmanifest
│   ├── sw.js                   # template; build fills in the version
│   ├── icon-192.png            # resized once from build/appicon.png
│   └── icon-512.png
└── src/
    ├── main.ts                 # restore remembered items on start; update toast; unsupported-browser message
    ├── tree.ts                 # report top-level list changes; collapsed "needs access" folders
    ├── fs-access.d.ts          # + launchQueue types
    └── backend/
        ├── index.ts            # + rememberedItems(), rememberItems()
        ├── wails.ts            # the two new methods do nothing (desktop unchanged)
        ├── web.ts              # service worker registration, launchQueue, remembered handles, save-permission banner
        └── handle-store.ts     # NEW: tiny IndexedDB get/set for the handle list

.github/workflows/pages.yml     # NEW: build frontend and publish dist-web/ to GitHub Pages
```

**Structure Decision**: Everything stays in the existing `frontend/` app. Web-only files go in a new
`public-web/` folder that only the web build copies (Vite's `publicDir` set per mode), so the desktop
build doesn't ship a manifest or service worker.

## Phases

### Phase 0: Research — done
All open questions resolved in [research.md](./research.md). One item needs your input before the
publishing step only: the repo has no GitHub remote yet, and free GitHub Pages needs a public repo
(R6).

### Phase 1: Design — done
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

### Suggested build order (for /speckit-tasks)
1. Installable: manifest, icons, `public-web/`, `preview:web`, service worker with caching (Story 1
   and the offline half of Story 2). This is the minimum useful slice.
2. Update toast with save-before-reload (rest of Story 2).
3. Unsupported-browser message and CSP meta (edge cases, R7, R8).
4. File Explorer launches and the save-permission banner (Story 3).
5. Remembered left pane (Story 4).
6. GitHub Pages workflow (needs the repo decision in R6).

## Complexity Tracking

| Deviation                                   | Why Needed                                       | Simpler Alternative Rejected Because                                                       |
|---------------------------------------------|--------------------------------------------------|--------------------------------------------------------------------------------------------|
| Only a CSP `<meta>` tag, no other security headers | You chose GitHub Pages (Q1: A), which can't set headers | Switching to Cloudflare Pages or Netlify would allow a `_headers` file; still open if you want it. |
| CSP enforced from the start, not Report-Only | `<meta>` CSP doesn't support Report-Only          | Covered by quickstart check 7 (no CSP errors in the console).                              |
