# Contract: Web App Manifest

**File**: `frontend/public-web/manifest.webmanifest`, published as `./manifest.webmanifest`.
Linked from `index.html` with `<link rel="manifest" href="./manifest.webmanifest">`.

This is what the browser reads to install MdGeek and to register it for `.md` files. All URLs are
relative so the app works under GitHub Pages' `/<repo-name>/` path and on `localhost`.

```json
{
  "name": "MdGeek",
  "short_name": "MdGeek",
  "description": "A Markdown editor with WYSIWYG and source views.",
  "id": "./",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "<the default theme's page background>",
  "theme_color": "<the default theme's toolbar color>",
  "icons": [
    { "src": "./icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ],
  "file_handlers": [
    {
      "action": "./",
      "accept": { "text/markdown": [".md", ".markdown"] }
    }
  ],
  "launch_handler": { "client_mode": "focus-existing" }
}
```

**Guarantees**:
- `id` stays `"./"` forever. Changing it makes browsers treat MdGeek as a different app, and users
  would have to reinstall.
- The two colors are copied from the default theme in `style.css` so the title bar and splash
  screen match.
- Must pass the install checks in Edge DevTools > Application > Manifest with no errors.
