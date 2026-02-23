import { defineConfig } from 'vite';
import { svelte }       from '@sveltejs/vite-plugin-svelte';
import { VitePWA }      from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte({
      onwarn(warning, handler) {
        // Internal desktop app — suppress all A11y warnings
        if (warning.code.startsWith('a11y-')) return;
        handler(warning);
      },
    }),
    VitePWA({
      registerType: 'autoUpdate',
      // Include the icon files as additional static assets
      includeAssets: ['favicon.png', 'icons/*.png'],
      manifest: {
        name: 'CrispLens',
        short_name: 'CrispLens',
        description: 'AI-Powered Image & Face Recognition',
        theme_color: '#1a1a2e',
        background_color: '#0e0e1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        categories: ['photography', 'productivity', 'utilities'],
      },
      workbox: {
        // Precache all JS/CSS/HTML/font/image assets
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff,woff2}'],
        // SPA fallback — all navigation routes serve index.html
        navigateFallback: 'index.html',
        // Never intercept /api/ requests with the SW (always go to network)
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // API calls: always network, never cache
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.FACE_REC_PORT || 7865}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
