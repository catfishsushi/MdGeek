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
      const htmlPath = resolve(out, 'index.html');
      writeFileSync(htmlPath, addContentSecurityPolicy(readFileSync(htmlPath, 'utf8')));
      const html = readFileSync(htmlPath);
      const version = createHash('sha256').update(html).digest('hex').slice(0, 8);
      const swPath = resolve(out, 'sw.js');
      const sw = readFileSync(swPath, 'utf8');
      if (!sw.includes('__VERSION__')) throw new Error('dist-web/sw.js has no __VERSION__ to replace');
      writeFileSync(swPath, sw.replaceAll('__VERSION__', version));
    },
  };
}

/**
 * Adds a Content-Security-Policy to the page, so a script slipped into a document can't run. GitHub
 * Pages can't send it as a header, so it goes in a <meta> tag. The app's one inline script is allowed
 * by its hash; inline styles are allowed because the editors set them; fonts come as data: URLs.
 */
function addContentSecurityPolicy(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script/gi)].map((m) => m[1]);
  if (scripts.length !== 1) throw new Error(`expected one inline script in index.html, found ${scripts.length}`);
  const hash = createHash('sha256').update(scripts[0]).digest('base64');
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
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
