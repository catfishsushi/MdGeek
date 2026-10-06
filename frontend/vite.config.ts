import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// "npm run build" makes the files the desktop app embeds (dist/).
// "npm run build:web" makes the browser version: one self-contained HTML file in dist-web/.
export default defineConfig(({ mode }) =>
  mode === 'web' ? { plugins: [viteSingleFile()], build: { outDir: 'dist-web' } } : {},
);
