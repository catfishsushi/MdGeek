# MdGeek Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-10-06

## Active Technologies

- TypeScript 5.6 (frontend), Go (desktop shell, not touched) + Vite 7, `vite-plugin-singlefile` (existing). No new runtime dependencies. (001-installable-pwa)

## Project Structure

```text
*.go                 # Wails desktop shell (main.go, app.go, links.go, settings.go)
frontend/src/        # TypeScript app; backend/ picks Wails (desktop) or web (browser) at build time
frontend/public-web/ # web-build-only files (manifest, service worker, icons)
specs/               # spec-kit feature specs
```

## Commands

- Desktop app: `wails build` (repo root)
- Browser build: `cd frontend; npm run build:web` (writes `frontend/dist-web/`); `npm run preview:web`
  serves it at http://localhost:4173 (installing and offline use work there without HTTPS)
- Wails isn't on the PATH here: run it as `~/go/bin/wails.exe build`
- No automated tests or linter yet; `npm run build` runs `tsc` type checks.

## Code Style

TypeScript 5.6 (frontend), Go (desktop shell, not touched): Follow standard conventions

## Recent Changes

- 001-installable-pwa: Added TypeScript 5.6 (frontend), Go (desktop shell, not touched) + Vite 7, `vite-plugin-singlefile` (existing). No new runtime dependencies.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
