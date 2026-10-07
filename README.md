# MdGeek

A Markdown editor with WYSIWYG and source views, tabs, a file tree, and themes. It comes as a Windows
desktop app and as a browser version for PCs that block unsigned programs.

## Browser version and installing

Open https://catfishsushi.github.io/MdGeek/ in **Edge or Chrome** on a computer. Firefox and Safari
can't run it, because they lack the browser feature MdGeek uses to read and save files on your PC.

- **Install it as an app:** click the install icon in the address bar (or the browser menu > "Install
  MdGeek"). It then opens from the Start menu or taskbar in its own window. Nothing is downloaded or
  run outside the browser, so a rule against unsigned programs doesn't block it.
- **Offline:** after one visit, MdGeek starts and works with no network connection.
- **Updates:** when a new version is ready, MdGeek says so. Click Reload to save everything and switch,
  or keep working and get it the next time MdGeek starts.
- **Opening .md files:** once installed, right-click a `.md` file > Open with > MdGeek.
- **Permission prompts:** the browser asks before MdGeek can read or save your files. After a restart
  it asks again when you first click a folder or file in the left pane; choose "Allow on every visit"
  to stop that. A file opened from File Explorer may show an Allow button before its first save.
- **Privacy:** your documents never leave your PC. The site only hands out MdGeek's own files.

The browser version can also run from a single file: `frontend/dist-web/index.html` works when
opened straight from disk, without installing or offline use.

## Building

- **Desktop app:** `wails build` in the repo root. The installer is `build/bin/MdGeek-amd64-installer.exe`
  when built with `wails build -nsis`.
- **Browser version:** `cd frontend`, then `npm run build:web`. Output is `frontend/dist-web/`.
  `npm run preview:web` serves it at http://localhost:4173, where installing and offline use work
  without HTTPS.
- **Publishing:** every push to `main` builds the browser version and publishes it to GitHub Pages
  (`.github/workflows/pages.yml`).

## Live Development

To run in live development mode, run `wails dev` in the project directory. This will run a Vite development
server that will provide very fast hot reload of your frontend changes. If you want to develop in a browser
and have access to your Go methods, there is also a dev server that runs on http://localhost:34115. Connect
to this in your browser, and you can call your Go code from devtools.

You can configure the project by editing `wails.json`. More information about the project settings can be found
here: https://wails.io/docs/reference/project-config
