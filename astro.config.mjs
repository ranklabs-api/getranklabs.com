import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// @astrojs/sitemap has no per-page date source of its own, so `serialize`
// supplies lastmod. Blog posts use the real `date` field of each post in
// src/pages/blog/[slug].astro (the same value PR #10 emits as
// datePublished/dateModified). Other pages use the last git commit that
// touched their source file. Nothing uses the build time.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const slugSource = readFileSync(new URL('./src/pages/blog/[slug].astro', import.meta.url), 'utf8');
const postDates = {};
let currentSlug = null;
for (const line of slugSource.split('\n')) {
  const s = line.match(/^  '([a-z0-9-]+)': \{\s*$/);
  if (s) { currentSlug = s[1]; continue; }
  const d = currentSlug && line.match(/^    date: '([A-Za-z]+) (\d{1,2}), (\d{4})',?\s*$/);
  if (d) {
    const m = MONTHS.indexOf(d[1]) + 1;
    if (m) postDates[currentSlug] = `${d[3]}-${String(m).padStart(2, '0')}-${d[2].padStart(2, '0')}`;
    currentSlug = null;
  }
}
const newestPost = Object.values(postDates).sort().pop();

const gitDate = (file) => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
    return out ? out.slice(0, 10) : undefined;
  } catch { return undefined; }
};

function lastmodFor(url) {
  const path = new URL(url).pathname.replace(/\/$/, '');
  if (path === '/blog') return newestPost;
  const post = path.match(/^\/blog\/([^/]+)$/);
  if (post) return postDates[post[1]];
  if (path === '') return gitDate('src/pages/index.astro');
  return gitDate(`src/pages${path}.astro`);
}

export default defineConfig({
  integrations: [tailwind(), sitemap({
    // Query-string variants (e.g. /signup?plan=...) are not distinct pages.
    filter: (page) =>
      !page.includes('?') &&
      !page.includes('/signup-complete') &&
      !page.includes('/thank-you'),
    serialize(item) {
      const lm = lastmodFor(item.url);
      if (lm) item.lastmod = lm;
      return item;
    },
  })],
  output: 'static',
  site: 'https://getranklabs.com',
});
