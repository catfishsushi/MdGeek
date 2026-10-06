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
