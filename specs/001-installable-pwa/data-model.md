# Data Model: Installable MdGeek (PWA)

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-06

All data stays in the user's browser on their own PC. Nothing is sent to a server (FR-012).

## Remembered item

The left pane's top-level files and folders, saved so they can be listed again next session (FR-006).

**Where**: IndexedDB database `mdgeek`, object store `handles`, one record under the key `sidebar`.
The value is an ordered list of `FileSystemFileHandle` / `FileSystemDirectoryHandle` objects, saved
as-is (IndexedDB can store handles). File or folder comes from `handle.kind`. Paths aren't saved: on
start each handle goes through `register()` again and gets a fresh path, the same way a newly
picked item does.

**Rules**:
- The list order matches the left pane order.
- Only Markdown files and folders are stored; the tree already allows nothing else.
- Saved every time the tree's top-level list changes (open folder, add, remove). Writes are small.
- On start, a record whose handle can't be found (deleted or moved) is dropped and the list saved
  again without it.
- A record whose permission is `prompt` is kept. A folder shows an "Allow access to …" button (or
  starts collapsed in a list); access is asked for on the user's first click.
- If IndexedDB is blocked or fails, the app starts with an empty pane, as today, and shows no error.

**Lifecycle**:

```text
picked / dropped ──▶ listed (permission granted) ──▶ app closed ──▶ restored (permission "prompt")
                                ▲                                            │
                                └──────── user clicks it, allows ◀───────────┘
restored ──▶ handle not found ──▶ dropped from the list
restored ──▶ user declines ──▶ stays listed; message "Access wasn't allowed"; can pick again
```

## App version

One published release of MdGeek, cached so it runs offline.

**Where**: Cache Storage, cache name `mdgeek-<version>`, where `<version>` is the first 8 hex
characters of the SHA-256 hash of the built `index.html`.

**Contents**: `./`, `./index.html`, `./manifest.webmanifest`, `./icon-192.png`, `./icon-512.png`.

**Lifecycle**:

```text
installing ──▶ waiting (an older version still has a window open) ──▶ active
     │                     │
     │                     └── user clicks Reload: save all, take over, reload ──▶ active
     └── no older version ──▶ active
active (new) ──▶ deletes every other mdgeek-* cache
```

## Existing settings (unchanged)

Theme and other settings stay in `localStorage` under `mdgeek.*`. The installed app and the browser
tab share them, since they're the same site. The desktop `.exe` keeps its own settings.
