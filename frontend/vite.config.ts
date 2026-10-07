import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// "npm run build" makes the files the desktop app embeds (dist/).
// "npm run build:web" makes the browser version: one self-contained HTML file in dist-web/, plus the
// files from public-web/ (manifest, service worker, icons) that let it be installed as an app.

/**
 * Links the manifest and writes the build's version into dist-web/sw.js. The browser re-installs the
 * service worker only when sw.js changes, so a hash of index.html makes every release change it.
 */
function installable(): Plugin {
  return {
    name: 'mdgeek-installable',
    apply: 'build',
    // Only the browser build links the manifest, so the desktop app doesn't ask for a missing file.
    transformIndexHtml: () => [
      { tag: 'link', attrs: { rel: 'manifest', href: './manifest.webmanifest' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'theme-color', content: '#f6f8fa' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'icon', href: './icon-192.png' }, injectTo: 'head' },
    ],
    closeBundle() {
      const out = resolve(__dirname, 'dist-web');
      const html = readFileSync(resolve(out, 'index.html'));
      const version = createHash('sha256').update(html).digest('hex').slice(0, 8);
      const swPath = resolve(out, 'sw.js');
      const sw = readFileSync(swPath, 'utf8');
      if (!sw.includes('__VERSION__')) throw new Error('dist-web/sw.js has no __VERSION__ to replace');
      writeFileSync(swPath, sw.replaceAll('__VERSION__', version));
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === 'web'
    ? {
        plugins: [viteSingleFile(), installable()],
        publicDir: 'public-web',
        build: { outDir: 'dist-web' },
      }
    : { publicDir: false },
);
