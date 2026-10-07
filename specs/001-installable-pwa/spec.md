# Feature Specification: Installable MdGeek (Progressive Web App)

**Feature Branch**: `001-installable-pwa`
**Created**: 2026-10-06
**Status**: Draft
**Input**: User description: "Make the MdGeek browser version an installable progressive web app (PWA) that works offline and can open .md files, for work PCs that block unsigned executables"

## Background

MdGeek ships as a Windows desktop app (an unsigned `.exe`) and, since commit `ce7a93b`, as a browser
version: one self-contained HTML file that runs in Edge or Chrome. The browser version exists for PCs
that block unsigned executables. Today it behaves like a web page: it lives in a browser tab, can't be
pinned like an app, can't be set to open `.md` files, and the user has to pick their folder again
every session.

A progressive web app (PWA) is a website the browser can install as an app: it gets its own window,
Start menu and taskbar entry, and can keep working with no network connection. Installing one is done
by the browser itself, so no executable is ever downloaded or run on the user's PC.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install MdGeek as an app (Priority: P1)

A user on a work PC that blocks unsigned programs opens the MdGeek web address in Edge or Chrome,
chooses "Install", and from then on starts MdGeek from the Start menu or taskbar. It opens in its own
window with MdGeek's name and icon, without the browser's address bar or tabs.

**Why this priority**: This is the core of the feature. Without it, MdGeek on locked-down PCs stays a
browser tab that is easy to lose and doesn't feel like an app.

**Independent Test**: Visit the hosted address in Edge, install it, close the browser, and start
MdGeek from the Start menu. It opens in its own window with the MdGeek icon and title, and every
feature of today's browser version works.

**Acceptance Scenarios**:

1. **Given** a user visits the MdGeek address in Edge or Chrome, **When** the page finishes loading, **Then** the browser offers to install it (the install icon in the address bar or the "Install MdGeek" menu item).
2. **Given** the user installs MdGeek, **When** they start it from the Start menu or taskbar, **Then** it opens in its own window titled MdGeek, using the MdGeek icon, with no address bar or tabs.
3. **Given** MdGeek is installed, **When** the user uninstalls it from the browser's app settings or from Windows "Apps", **Then** it is removed like any other installed web app.

---

### User Story 2 - Keep working with no network connection (Priority: P2)

A user who has opened MdGeek at least once can start it and edit their Markdown files while offline,
for example on a plane or when the server hosting MdGeek is down.

**Why this priority**: The files being edited are already on the user's own PC, so losing the network
should not stop them from working. It's also part of what makes an installed app feel like an app.

**Independent Test**: Open MdGeek once while online, disconnect from the network (or stop the hosting
server), then start MdGeek from the Start menu, open a folder, and edit and save a file.

**Acceptance Scenarios**:

1. **Given** MdGeek has been opened at least once while online, **When** the user starts it with no network connection, **Then** it loads fully and all editing, preview, theme, and save features work.
2. **Given** a newer version of MdGeek has been published, **When** the user next opens MdGeek while online, **Then** the new version is downloaded in the background and the user is told a new version is ready, applied the next time MdGeek starts (or right away if they choose to reload).
3. **Given** the user has unsaved edits, **When** a new version becomes available, **Then** nothing reloads on its own and no edits are lost.

---

### User Story 3 - Open .md files from File Explorer (Priority: P3)

A user double-clicks a `.md` file in File Explorer (or uses "Open with > MdGeek") and it opens in the
installed MdGeek, the way it does in the desktop app.

**Why this priority**: It's the main desktop convenience the browser version lost (the commit message
for `ce7a93b` lists it as a limit). It depends on Story 1, and some company browser policies may block
it, so it comes after the basics.

**Independent Test**: With MdGeek installed, right-click a `.md` file in File Explorer, choose
"Open with > MdGeek", and confirm the file opens and can be edited and saved.

**Acceptance Scenarios**:

1. **Given** MdGeek is installed, **When** the user opens a `.md` or `.markdown` file with MdGeek from File Explorer, **Then** MdGeek opens that file, ready to edit and save, and lists it in the left pane.
2. **Given** MdGeek is already open, **When** the user opens another `.md` file from File Explorer, **Then** it opens in the existing MdGeek window rather than a second window. [Assumes the browser supports it; if not, a new window is acceptable.]
3. **Given** the browser asks the user whether MdGeek may open this type of file, **When** the user says no, **Then** MdGeek still opens, without the file, and shows no error.

---

### User Story 4 - Reopen last session's files and folders (Priority: P3)

When the user starts the installed MdGeek, the files and folders they had open last time are listed
again in the left pane. The first time they open or save one, the browser may ask once to allow
access, instead of making them find and pick the folder again.

**Why this priority**: Picking the folder again every session is the other main annoyance listed for
the browser version. It improves daily use but isn't needed for the app to be usable.

**Independent Test**: Open a folder in MdGeek, close it, start it again, and confirm the folder is
listed. Click a file in it and confirm it opens after at most one "allow access" prompt.

**Acceptance Scenarios**:

1. **Given** the user had a folder open when they closed MdGeek, **When** they start MdGeek again, **Then** that folder is listed in the left pane.
2. **Given** a remembered folder was deleted or moved since last time, **When** MdGeek starts, **Then** it is quietly dropped from the list, not shown with an error.
3. **Given** the user declines the "allow access" prompt, **When** they try to open a file from that folder, **Then** MdGeek shows a short message saying access wasn't allowed, and the folder can be picked again.

---

### Edge Cases

- The user opens MdGeek in Firefox or Safari, which can't install it and lack the file access MdGeek needs: the page says MdGeek needs Edge or Chrome. (Today's browser version doesn't check this; it's added by this feature.)
- Company browser policy turns off installing web apps: MdGeek still works as a normal web page in a tab (today's browser version), and nothing on the page is broken.
- The user's first-ever visit is offline: the page can't load, which is expected; offline use starts after one online visit.
- The hosting address changes: an installed MdGeek is tied to its address, so users would need to install again from the new one.
- A new version is published while the user has unsaved edits (covered in Story 2, scenario 3).
- The desktop `.exe` and the installed web app are both set up on the same PC: each keeps its own settings; neither breaks the other.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: MdGeek MUST be installable from Edge and Chrome on Windows, showing the MdGeek name and icon in the install prompt, the Start menu, the taskbar, and the window title.
- **FR-002**: The installed MdGeek MUST open in its own window without browser tabs or an address bar.
- **FR-003**: After one successful online visit, MdGeek MUST load and work fully with no network connection.
- **FR-004**: When a new version is published, MdGeek MUST get it on the next online start and tell the user it's ready, and MUST NOT reload while there are unsaved edits.
- **FR-005**: The installed MdGeek MUST register to open `.md` and `.markdown` files from the operating system, and open a file passed to it this way, ready to edit and save.
- **FR-006**: MdGeek MUST remember the files and folders listed in the left pane between sessions, and list them again on start.
- **FR-007**: MdGeek MUST ask the browser for access to a remembered file or folder only when the user first opens or saves something in it, not at startup.
- **FR-008**: Every feature of today's browser version (editing, WYSIWYG view, preview, themes, settings, Ctrl+Click links, drag and drop) MUST work the same in the installed app.
- **FR-009**: MdGeek MUST still work as a normal web page in a browser tab for users who don't or can't install it.
- **FR-010**: The desktop app and today's single-file browser build MUST keep working unchanged. The single HTML file stays available for opening straight from disk, where installing and offline caching don't apply.
- **FR-011**: MdGeek MUST be served from a free static web host such as GitHub Pages, over HTTPS. No server program is written or run for it. For local testing, it MUST also work when served from `localhost`.
- **FR-012**: The installed app MUST NOT send the user's documents or file names anywhere; all file reading and writing stays on the user's PC.

### Key Entities

- **Remembered item**: a file or folder the user had listed in the left pane, kept between sessions so it can be listed again. Holds the browser's permission to reach that item, plus its display name.
- **App version**: the set of files making up one published release of MdGeek, kept on the PC so it can run offline, and replaced when a newer one is published.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a Windows PC that blocks unsigned executables, a user can go from visiting the MdGeek address to starting it from the Start menu in under 1 minute, without IT help or any download.
- **SC-002**: With the network unplugged, the installed MdGeek starts and opens a file in under 3 seconds.
- **SC-003**: Opening a `.md` file from File Explorer shows it in MdGeek, ready to edit, in under 3 seconds.
- **SC-004**: Starting MdGeek and reopening yesterday's folder takes at most one permission prompt and no folder picking.
- **SC-005**: No edits are lost when a new version is published while a file has unsaved changes (checked by publishing a new version during an edit and confirming the edit is still there and saveable).

## Assumptions

- Target browsers are Edge and Chrome on Windows, the same as today's browser version. Firefox and Safari are out of scope since they lack the needed file access.
- The PWA grows out of the existing browser build (`frontend/src/backend/web.ts`); there is no separate code base.
- MdGeek needs no server-side features: no accounts, no syncing, no uploads. The server only hands out the app's files.
- The built app will be publicly reachable on the static host. That's fine because it contains no secrets or user data; documents never leave the user's PC (FR-012).
- MdGeek's existing icon (`build/appicon.png`) is used for the installed app.
- Installing a PWA isn't blocked by a rule against unsigned executables, because no executable runs on the user's PC. Company browser policy can still turn off installs; when it does, MdGeek falls back to the in-tab experience (FR-009).
- Opening `.md` files from File Explorer and reopening remembered folders depend on browser features that Edge and Chrome support for installed apps; if a company policy disables them, the rest of the feature still works.
