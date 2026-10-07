# Tasks: Installable MdGeek (Progressive Web App)

**Input**: Design documents from `/specs/001-installable-pwa/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: The spec doesn't ask for automated tests and the repo has none. Each story ends with a
manual check from `quickstart.md`. `npm run build` and `npm run build:web` (both run `tsc`) must pass
after every task.

**Organization**: Tasks are grouped by user story so each can be built and checked on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Paths are relative to the repo root `C:\DevProjects\MdGeek`

## Key facts for whoever implements this

- The browser build is `cd frontend; npm run build:web`, which runs `vite build --mode web` and
  writes one self-contained `frontend/dist-web/index.html` (about 7 MB) using `vite-plugin-singlefile`.
- `frontend/src/backend/index.ts` picks `webBackend` (`web.ts`) or `wailsBackend` (`wails.ts`) at build
  time from `import.meta.env.MODE`. The rest of the app only talks to `backend`.
- `web.ts` keeps picked and dropped handles in a `roots` map keyed by a made-up top-level name; paths
  look like `/notes/sub/todo.md`. `register(handle)` adds a handle and returns its path.
- `main.ts` has `toast(msg)` (text only, hides after 3.5 s), `renderBanner()` (the yellow bar above the
  editor, currently only for disk conflicts), `openPaths(paths)`, `flushAll()`, and `saveNow(tab)`.
- `tree.ts` `Tree` holds `roots: TreeItem[]`; `setRoot()` replaces them and `add()` appends; a private
  `remove()` drops one. `fill()` calls `backend.listDir()` and catches its errors.
- The repo's default branch is `main` (renamed from `master` on 2026-10-06).
- The GitHub repo `catfishsushi/MdGeek` doesn't exist yet. It will be public. Its history must be
  rewritten to the noreply email before the first push (see T040).
- Follow the code style already in the repo: short plain-English comments explaining why, no library
  where a few lines will do.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Web-only files folder, preview command, icons, and type declarations.

- [x] T001 Create `frontend/public-web/` and set Vite's `publicDir` to `public-web` in web mode only, and to `false` otherwise, in `frontend/vite.config.ts`, so the desktop build (`dist/`) never gets the manifest or service worker
- [x] T002 [P] Add `"preview:web": "vite preview --mode web"` to `scripts` in `frontend/package.json` and confirm it serves `frontend/dist-web/` at `http://localhost:4173`
- [x] T003 [P] Make `frontend/public-web/icon-192.png` (192×192) and `frontend/public-web/icon-512.png` (512×512) from `build/appicon.png` (1024×1024), using a one-off PowerShell `System.Drawing` resize run from the scratchpad (not part of the build), and commit the two PNGs
- [x] T004 [P] Add `launchQueue` types to `frontend/src/fs-access.d.ts`: `interface LaunchParams { files: FileSystemHandle[] }`, `interface LaunchQueue { setConsumer(fn: (p: LaunchParams) => void): void }`, and `launchQueue?: LaunchQueue` on `Window`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The build step every story's published output depends on.

- [x] T005 Add a small inline Vite plugin in `frontend/vite.config.ts` (web mode only) that runs in `closeBundle`: reads `dist-web/index.html`, computes the first 8 hex characters of its SHA-256 (Node `crypto`), and replaces `__VERSION__` in `dist-web/sw.js` with it. Fails the build if `sw.js` is missing or has no `__VERSION__`

**Checkpoint**: `npm run build:web` produces `dist-web/` with `index.html`, the two icons, and anything placed in `public-web/`.

---

## Phase 3: User Story 1 - Install MdGeek as an app (Priority: P1) 🎯 MVP

**Goal**: Edge and Chrome offer to install MdGeek; it opens in its own window with its name and icon, and loads offline after one visit.

**Independent Test**: `quickstart.md` checks 1 and 2.

- [x] T006 [P] [US1] Write `frontend/public-web/manifest.webmanifest` per `specs/001-installable-pwa/contracts/manifest.md`, **without** `file_handlers` and `launch_handler` (added in US3). Take `background_color` from `--bg` and `theme_color` from `--bg-alt` in the `:root` block of `frontend/src/style.css`
- [x] T007 [P] [US1] Write `frontend/public-web/sw.js` per `specs/001-installable-pwa/contracts/service-worker.md`: `const VERSION = '__VERSION__'`, cache `mdgeek-${VERSION}`, files `./`, `./index.html`, `./manifest.webmanifest`, `./icon-192.png`, `./icon-512.png` resolved against `self.registration.scope`; `install` caches them (no `skipWaiting`); `activate` deletes other `mdgeek-*` caches and calls `clients.claim()`; `fetch` answers same-origin GETs for those files cache-first, network fallback, and ignores everything else. Leave out the `message` handler (US2)
- [x] T008 [US1] (Done in the `installable()` Vite plugin's `transformIndexHtml` instead of editing `index.html`, so only the web build gets these tags; also adds a favicon link.) Add `<link rel="manifest" href="./manifest.webmanifest">` and `<meta name="theme-color" content="…">` (same value as the manifest) to `frontend/index.html`. Opening `dist-web/index.html` from disk must still work; a missing manifest there is harmless
- [x] T009 [US1] Register the service worker in `frontend/src/backend/web.ts` at module load: only if `'serviceWorker' in navigator` and (`location.protocol === 'https:'` or `location.hostname === 'localhost'`), call `navigator.serviceWorker.register('./sw.js', { scope: './' })`, and ignore failures (log with `console.warn`). Export the registration promise for US2
- [x] T010 [US1] Run `npm run build:web` and `npm run preview:web`, then do `quickstart.md` checks 1 and 2 in Edge (Playwright browser tools can confirm the manifest loads, the service worker is active, and the page reloads with the network offline). Confirm `npm run build` (desktop) output has no `manifest.webmanifest` or `sw.js`

**Checkpoint**: MdGeek installs from `localhost`, opens in its own window, and works offline. This alone is a usable release.

---

## Phase 4: User Story 2 - Keep working with no network connection (Priority: P2)

**Goal**: Offline already works from US1; this adds safe updates: the user is told a new version is ready and nothing reloads with unsaved edits.

**Independent Test**: `quickstart.md` check 3.

- [ ] T011 [P] [US2] Add the `message` handler to `frontend/public-web/sw.js`: on `{ type: 'activate-now' }` call `self.skipWaiting()`; ignore any other message
- [ ] T012 [P] [US2] Let `toast` in `frontend/src/main.ts` take an optional action, `toast(msg, action?: { label: string; run: () => void })`. With an action, show a button after the text and don't auto-hide. Style the button in `frontend/src/style.css` to match existing banner buttons
- [ ] T013 [US2] Add `onUpdateReady(fn: (apply: () => Promise<void>) => void): void` to the `Backend` interface in `frontend/src/backend/index.ts`; make it do nothing in `frontend/src/backend/wails.ts`; and implement it in `frontend/src/backend/web.ts` using the registration from T009: call `fn` when `registration.waiting` exists at startup or when an `installing` worker reaches `installed` while a controller exists. `apply()` posts `{ type: 'activate-now' }` to the waiting worker and reloads the page once on `controllerchange`
- [ ] T014 [US2] In `frontend/src/main.ts`, call `backend.onUpdateReady` and show `toast('A new version of MdGeek is ready.', { label: 'Reload', run })`, where `run` awaits `flushAll()`, then checks no tab is still dirty: if any is, toast "Couldn't save everything, so MdGeek didn't reload." and stop; otherwise call `apply()`. Make `flushAll` report failure if it doesn't already (check `saveNow` error handling)
- [ ] T015 [US2] Update `specs/001-installable-pwa/contracts/service-worker.md` "Backend interface changes" to list `onUpdateReady`
- [ ] T016 [US2] Do `quickstart.md` check 3: edit without saving, rebuild with a visible text change, trigger an update check, confirm the toast appears, nothing reloads by itself, and Reload saves the edit to disk before showing the new version

**Checkpoint**: Releases reach users safely; no edit is lost to an update.

---

## Phase 5: User Story 3 - Open .md files from File Explorer (Priority: P3)

**Goal**: The installed app registers for `.md` / `.markdown` and opens files sent from File Explorer, in the existing window.

**Independent Test**: `quickstart.md` check 4.

- [ ] T017 [P] [US3] Add `file_handlers` (`action: "./"`, `accept: { "text/markdown": [".md", ".markdown"] }`) and `launch_handler: { "client_mode": "focus-existing" }` to `frontend/public-web/manifest.webmanifest`, matching `contracts/manifest.md`
- [ ] T018 [US3] Implement `onOpenPaths(fn)` in `frontend/src/backend/web.ts`: if `window.launchQueue` exists, `setConsumer` with a function that skips empty `files`, `register()`s each handle, and calls `fn(paths)`. Replace the comment on `startupPaths` that mentions `launchQueue`, since launches now arrive through `onOpenPaths`. Confirm in `frontend/src/main.ts` that `backend.onOpenPaths` is set up before anything awaits, so a launch at startup isn't missed
- [ ] T019 [US3] Add `allowSaving(path: string): Promise<boolean>` to `Backend` in `frontend/src/backend/index.ts` (asks for write access; must be called from a click). Wails returns `true` in `frontend/src/backend/wails.ts`; web calls `requestPermission({ mode: 'readwrite' })` on the file's handle in `frontend/src/backend/web.ts`. Make `ensureWritable` in `web.ts` throw a recognizable error (for example `class NeedsPermission extends Error`, exported) when the request fails for lack of a click
- [ ] T020 [US3] In `frontend/src/main.ts`, when a save fails with `NeedsPermission`, mark the tab (`tab.needsPermission = true`), pause autosave for it, and extend `renderBanner()` to show "MdGeek needs permission to save {file}." with an **Allow** button that calls `backend.allowSaving(tab.path)` and, if granted, clears the flag and calls `saveNow(tab)`. Disk-conflict banners keep priority
- [ ] T021 [US3] Update `contracts/service-worker.md` "Backend interface changes" to list `allowSaving`
- [ ] T022 [US3] Do `quickstart.md` check 4 with the app installed from `localhost`: Open with > MdGeek, second file to the same window, edit and save (with Allow if the banner shows), and decline the file-type prompt once. Record in `research.md` R4 whether Chrome/Edge granted write access without a prompt

**Checkpoint**: Double-clicking or "Open with" a `.md` file opens it in MdGeek and it can be saved.

---

## Phase 6: User Story 4 - Reopen last session's files and folders (Priority: P3)

**Goal**: The left pane's top-level items come back on the next start, asking for access only when first clicked.

**Independent Test**: `quickstart.md` check 5.

- [ ] T023 [P] [US4] Create `frontend/src/backend/handle-store.ts` per `data-model.md`: `loadHandles(): Promise<{ name: string; handle: FileSystemHandle }[]>` and `saveHandles(list): Promise<void>`, using raw IndexedDB (database `mdgeek`, version 1, object store `handles`, key `sidebar`). Both resolve quietly (empty list / no change) if IndexedDB is unavailable or errors
- [ ] T024 [US4] Add `rememberedItems(): Promise<{ path: string; isDir: boolean }[]>` and `rememberItems(items: { path: string; isDir: boolean }[]): Promise<void>` to `Backend` in `frontend/src/backend/index.ts` (use an inline type to avoid importing from `tree.ts`, which imports `backend`). Wails returns `[]` and does nothing in `frontend/src/backend/wails.ts`
- [ ] T025 [US4] Implement them in `frontend/src/backend/web.ts`: `rememberItems` maps each item's top-level name to its handle from `roots` and calls `saveHandles`. `rememberedItems` calls `loadHandles`, drops entries whose handle throws `NotFoundError` (for a folder, try `entries().next()` only if permission is already `granted`; otherwise keep it), puts the rest back into `roots` under their saved names, saves the trimmed list if anything was dropped, and returns their paths
- [ ] T026 [US4] Make `lookup` in `frontend/src/backend/web.ts` ask for access when the top-level handle's `queryPermission({ mode: 'readwrite' })` isn't `granted`: call `requestPermission` (works because it runs from the user's click on the tree), and throw `new Error("access wasn't allowed")` if refused
- [ ] T027 [US4] In `frontend/src/tree.ts`, accept an `onRootsChange(items: TreeItem[])` callback in the constructor and call it at the end of `setRoot`, `add`, and `remove`. Add `restore(items: TreeItem[])` that sets `roots` without expanding folders and without calling `onRootsChange`, so restored folders show collapsed until clicked
- [ ] T028 [US4] In `frontend/src/tree.ts` `fill()`, when `listDir` fails with "access wasn't allowed", show "Access wasn't allowed. Click to try again." in that folder's place instead of the generic error; clicking it retries
- [ ] T029 [US4] In `frontend/src/main.ts`, pass `(items) => void backend.rememberItems(items)` to the `Tree` constructor, and at startup (in the existing `loadSavedTheme().then(...)` chain, before `startupPaths`) call `backend.rememberedItems()` and `tree.restore(...)` if the list isn't empty
- [ ] T030 [US4] Update `contracts/service-worker.md` "Backend interface changes" to match the final `rememberedItems` / `rememberItems` signatures
- [ ] T031 [US4] Do `quickstart.md` check 5: restart lists both items with no prompt until clicked, then at most one; "Allow on every visit" removes later prompts; a renamed folder disappears quietly; declining shows the message and picking again works

**Checkpoint**: All four stories work in the installed app on `localhost`.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Unsupported browsers, security, publishing, and docs.

- [ ] T032 [P] In `frontend/src/main.ts` (web build only, `import.meta.env.MODE === 'web'`), if `!('showDirectoryPicker' in window)`, replace the `#empty` text with "MdGeek needs Edge or Chrome on a computer." and disable `#btn-open-file` and `#btn-open-folder` (research R8)
- [ ] T033 [P] Extend the Vite plugin from T005 in `frontend/vite.config.ts`: after inlining, compute the SHA-256 of the inlined `<script type="module">` body and insert the CSP `<meta http-equiv="Content-Security-Policy">` from research R7 at the top of `<head>` in `dist-web/index.html`, **before** computing the `sw.js` version hash
- [ ] T034 Do `quickstart.md` check 7: rerun checks 1–5 with the console open and fix any CSP errors (likely candidates: Milkdown/CodeMirror inline styles, `blob:` images, highlight.js). Also confirm `dist-web/index.html` opened from disk still works with the CSP
- [ ] T035 Do `quickstart.md` check 6 (normal tab, opened from disk, Firefox message, desktop `wails build` unchanged)
- [ ] T036 [P] Create `.github/workflows/pages.yml`: on push to `main` and `workflow_dispatch`; permissions `contents: read`, `pages: write`, `id-token: write`; job runs `actions/checkout`, `actions/setup-node` (Node 22, npm cache on `frontend/package-lock.json`), `npm ci` and `npm run build:web` in `frontend/`, `actions/configure-pages`, `actions/upload-pages-artifact` with `path: frontend/dist-web`, then a `deploy` job with `actions/deploy-pages`. Use a `concurrency: pages` group
- [ ] T037 [P] Add a `.gitattributes` with `*.sh text eol=lf` so spec-kit's Bash scripts keep Unix line endings on Windows checkouts
- [ ] T038 [P] Add a "Browser version and installing" section to `README.md`: the Pages address, how to install from Edge or Chrome, offline use, opening `.md` files, the permission prompts, and the Firefox/Safari limit. Update the build commands in `CLAUDE.md` with `npm run preview:web`
- [x] T039 Default branch renamed from `master` to `main` (2026-10-06), so `quickstart.md` and `research.md` R6 are already correct
- [x] T040 (done 2026-10-06) rewrite every commit's author and committer email from the personal Gmail address to `42792811+catfishsushi@users.noreply.github.com` across all branches, then confirm `git log --all --format='%ae %ce'` shows only the noreply address
- [x] T041 (done 2026-10-06) After T040: create the public repo with `gh repo create catfishsushi/MdGeek --public --source C:\DevProjects\MdGeek`, push `main`, `feature/wysiwyg-toolbar`, and `001-installable-pwa`, and set Settings > Pages > Source to "GitHub Actions" (`gh api -X POST repos/catfishsushi/MdGeek/pages -f build_type=workflow`)
- [ ] T042 After merge to `main` and the first workflow run: repeat `quickstart.md` checks 1–4 against `https://catfishsushi.github.io/MdGeek/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none. T002–T004 can run in parallel after T001.
- **Foundational (Phase 2)**: T005 needs T001.
- **US1 (Phase 3)**: needs Phase 2. It's the base for every other story, since US2 and US3 need the service worker and manifest it creates.
- **US2 (Phase 4)**: needs US1 (T007, T009).
- **US3 (Phase 5)**: needs US1 (T006, the manifest). Independent of US2.
- **US4 (Phase 6)**: needs only Phase 1. Works in a normal browser tab too, so it doesn't need US1 at all.
- **Polish (Phase 7)**: T033–T034 after all stories (the CSP must be checked against everything). T036–T039 any time. T040 → T041 → (merge) → T042.

### Within Each User Story

- Manifest and service worker files before the code that registers or uses them.
- Backend interface (`index.ts`) before `wails.ts` / `web.ts`, before `main.ts` / `tree.ts`.
- Each story ends with its quickstart check.

### Parallel Opportunities

- Setup: T002, T003, T004.
- US1: T006 and T007.
- US2: T011 and T012.
- US3 and US4 can be built side by side once US1 is done; they touch different parts of `web.ts`, so merge carefully.
- Polish: T032, T033, T036, T037, T038.

## Parallel Example: User Story 1

```text
Task: "T006 [US1] Write frontend/public-web/manifest.webmanifest"
Task: "T007 [US1] Write frontend/public-web/sw.js"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 and Phase 2.
2. Phase 3 (US1).
3. Stop and run quickstart checks 1–2. MdGeek is installable and works offline.

### Incremental Delivery

1. US1 → installable and offline (MVP).
2. US2 → safe updates. Do this before publishing anywhere public, so the first real release can update itself safely.
3. US3 → File Explorer.
4. US4 → remembered left pane.
5. Polish → CSP, Firefox message, publish to GitHub Pages.

## Notes

- Commit after each task or logical group, using the noreply email (already set in this repo's git config).
- `npm run build` and `npm run build:web` must both pass after every task, because the two builds share all of `frontend/src/`.
- Don't add libraries for the service worker or IndexedDB; the plan chose hand-written versions (research R1, R5).
