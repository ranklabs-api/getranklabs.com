import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  integrations: [tailwind(), sitemap({
    customPages: [
      'https://getranklabs.com/signup?plan=full_management',
      'https://getranklabs.com/signup?plan=seo_management',
    ],
    filter: (page) => !page.includes('/signup-complete') && !page.includes('/thank-you'),
  })],
  output: 'static',
  site: 'https://getranklabs.com',
});
