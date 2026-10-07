# MdGeek Backlog

Items in priority order. Work them top to bottom.

## 1. Formatting toolbar in WYSIWYG mode (done)

Add a toolbar shown in WYSIWYG mode with common formatting buttons (for example: bold, italic,
strikethrough, headings, bulleted and numbered lists, task list, link, code, quote, table).

## 2. Clickable links in WYSIWYG mode (done)

Clicking a link in WYSIWYG mode should open it in a new window (the system's default browser for web
links), not navigate the app's own window.

## 3. Drag and drop files from File Explorer into the left pane (done)

Dropping files from File Explorer onto the left pane (sidebar file tree) should add them there.

## 4. Discuss: what the left pane shows when opening a file vs. a folder (done)

**Discuss before building. Not until we reach this step.**

What happened: using "Open file" and picking a file loaded that file's parent folder and all its
subfolders into the left pane, along with the file itself.

Suggested behavior:

- Opening a **file** shows only that file in the left pane.
- Opening a **folder** shows the folder and its subfolders (what happens now).

Open to a more standard approach if this one is unusual. Talk it through first.

## 5. "SciFi" theme (done)

A theme with the feel of sci-fi movie and game interfaces. Inspiration:
https://www.sitepoint.com/14-top-sci-fi-designs-to-inspire-your-next-interface/

Readability comes first. Styled interfaces like these can be hard to read, so:

- Keep body text plain and high-contrast (meet WCAG AA contrast, 4.5:1 for normal text).
- Put the sci-fi styling in the frame (borders, panels, toolbar, sidebar, tabs), not in the text
  being edited.
- Keep animation subtle, and turn it off when the OS "reduce motion" setting is on.
- It is an option alongside light and dark, never the default.

## 6. Make MdGeek open source (FOSS)

Decided 2026-10-06 to do this later, not before the first push to GitHub. To do:

- Add a `LICENSE` file. MIT is the likely pick: 211 of 222 dependencies use it, and every dependency
  license (MIT, BSD, ISC, Apache-2.0, PSF-2.0, MPL-2.0/Apache-2.0) is compatible with it.
- Confirm where `frontend/src/assets/control-room.png` came from and that it may be shared; otherwise
  use the hand-made `control-room.svg` instead.
- Finish `README.md`: it now describes MdGeek, the browser version, and building, but still ends with
  Wails template text and has no license section.
- Name the owner in `wails.json` `"copyright"` (now just "Copyright © 2026").
- Optional: a `THIRD_PARTY_NOTICES.txt` for the bundled libraries, `SECURITY.md`, `CONTRIBUTING.md`,
  and deciding whether working notes (`REQUIREMENTS.md`, `backlog.md`, `.claude/`) stay public.

## 7. Bug: images without a title break the WYSIWYG view

Found 2026-10-06 while testing the installable browser version (it happens with and without that
feature's security policy, so it was already there). A Markdown image with no title, such as
`![pic](https://example.com/a.png)`, doesn't show in WYSIWYG view, and the console shows
`RangeError: Expected value of type string for attribute caption on type image-block, got null`
from the editor (Milkdown Crepe's image block). Source view is fine. Not yet checked in the desktop app.
