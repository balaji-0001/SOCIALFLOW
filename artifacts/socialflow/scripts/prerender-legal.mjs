// After `vite build`: writes /privacy, /terms and /data-deletion as complete HTML pages (real text inside the file), so
// crawlers and automated reviewers that don't run JavaScript (Meta, Google, LinkedIn app review) can read them. The
// React app still boots on top of the same markup for people, exactly as before.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist/public');
const tmp = path.join(root, 'node_modules/.prerender');

await build({
  configFile: false, root, logLevel: 'error', plugins: [react()],
  build: { ssr: 'src/app/legal-pages.tsx', outDir: tmp, emptyOutDir: true, rollupOptions: { output: { format: 'esm', entryFileNames: 'legal-pages.mjs' } } },
});
const legal = await import(pathToFileURL(path.join(tmp, 'legal-pages.mjs')).href);
const template = await readFile(path.join(dist, 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'src/app/legal.css'), 'utf8');
if (!template.includes('<div id="root"></div>')) throw new Error('index.html has no empty #root to fill');

const pages = [
  { route: 'privacy', Component: legal.PrivacyPage, title: 'Privacy Policy · SocialFlow', description: 'How SocialFlow handles your information.' },
  { route: 'terms', Component: legal.TermsPage, title: 'Terms of Service · SocialFlow', description: 'The terms for using SocialFlow.' },
  { route: 'data-deletion', Component: legal.DataDeletionPage, title: 'Data deletion · SocialFlow', description: 'How to disconnect your accounts and delete your SocialFlow data.' },
];
for (const page of pages) {
  const markup = renderToStaticMarkup(createElement(page.Component));
  const html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${page.description}" />`)
    .replace('</head>', `<style>${css}</style></head>`)
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
  await mkdir(path.join(dist, page.route), { recursive: true });
  await writeFile(path.join(dist, page.route, 'index.html'), html);
  console.log(`prerendered /${page.route} (${markup.length} bytes of text)`);
}
await rm(tmp, { recursive: true, force: true });
