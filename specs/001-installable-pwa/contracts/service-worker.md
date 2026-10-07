# Contract: Service Worker and Update Messages

**File**: `frontend/public-web/sw.js` (template), written to `dist-web/sw.js` by the build with the
version filled in. Registered from the page as `./sw.js` with scope `./`.

## Behavior

| Event      | What it does                                                                                       |
|------------|----------------------------------------------------------------------------------------------------|
| `install`  | Opens cache `mdgeek-<version>` and adds the five app files. Does **not** call `skipWaiting()`.     |
| `activate` | Deletes every cache whose name starts with `mdgeek-` and isn't the current one. Claims open pages. |
| `fetch`    | For GET requests to the app's own files: cache first, then network. Everything else: untouched.    |
| `message`  | `{ type: "activate-now" }` → calls `skipWaiting()`. No other messages.                             |

The service worker never reads, caches, or sends the user's documents. Those never go through
`fetch`; they are read from disk through file handles.

## Page side

Registration lives in `frontend/src/backend/web.ts` and runs only when
`location.protocol` is `https:` or the host is `localhost`. It's skipped when `index.html` is opened
straight from disk (`file:`), so the single-file build keeps working there.

When a new version is found:

```text
registration.waiting appears (or an "installed" state change on registration.installing)
  └─▶ toast: "A new version of MdGeek is ready."  [Reload]
         └─▶ click: await flushAll()
                ├─ any save failed ─▶ toast "Couldn't save everything, so MdGeek didn't reload." (stop)
                └─ all saved ─▶ waiting.postMessage({ type: "activate-now" })
                                  └─▶ on "controllerchange": location.reload()
```

## Backend interface changes

`frontend/src/backend/index.ts` `Backend` gains these methods. The desktop (Wails) backend implements
them as "nothing remembered" and a change with no effect, so the desktop app is unchanged (FR-010).

```ts
/** The left pane's top-level files and folders from last session, in order. [] if none. */
rememberedItems(): Promise<{ path: string; isDir: boolean }[]>;
/** Saves the left pane's top-level files and folders for next session. */
rememberItems(items: { path: string; isDir: boolean }[]): Promise<void>;
/** A new version is downloaded and waiting; apply() switches to it and reloads. Desktop: never called. */
onUpdateReady(fn: (apply: () => void) => void): void;
/** Asks (from a click) for permission to save this file. Saves throw NeedsPermission when needed. */
allowSaving(path: string): Promise<boolean>;
```

`NeedsPermission` lives in `frontend/src/backend/errors.ts`. When a save throws it, `main.ts` pauses
autosave for that tab and shows a banner with an Allow button that calls `allowSaving`.

Besides the update message, the web backend asks the browser to check for a new version once an hour,
since an app left open for days would otherwise only see updates when restarted.

`onOpenPaths` in the web backend now receives files from `launchQueue` (File Explorer "Open with").
Its signature doesn't change.
