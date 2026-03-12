import { defineConfig }   from 'vite';
import { svelte }         from '@sveltejs/vite-plugin-svelte';
import { VitePWA }        from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    svelte({
      onwarn(warning, handler) {
        // Internal desktop app — suppress all A11y warnings
        if (warning.code.startsWith('a11y-')) return;
        handler(warning);
      },
    }),

    // Copy onnxruntime-web and SQLite WASM files
    // Required for client-side inference and local SQLite in browser
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/onnxruntime-web/dist/*',
          dest: 'ort-wasm',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.wasm',
          dest: 'assets',
        },
        {
          src: 'node_modules/sql.js/dist/sql-wasm.wasm',
          dest: 'assets',
        },
        {
          src: 'node_modules/sql.js/dist/sql-wasm.wasm',
          dest: 'ort-wasm',
        },
        {
          // voy-search WASM binary (wasm-bindgen bundler target).
          src: 'node_modules/voy-search/voy_search_bg.wasm',
          dest: 'assets',
        },
        {
          // MediaPipe tasks-vision WASM runtime
          src: 'node_modules/@mediapipe/tasks-vision/wasm/*',
          dest: 'mediapipe',
        },
      ],
    }),

    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
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
        // Precaching static layout assets
        globPatterns: ['**/*.{html,png,svg,ico,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // 20MB
        navigateFallback: 'index.html',
        // Denylist must only contain API calls, NOT our logic bundles/wasm
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          // JS/CSS bundles: StaleWhileRevalidate for instant load + background update
          {
            urlPattern: /\/assets\/.*\.(js|mjs|css)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'crisplens-app-logic',
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          // WASM runtimes (ONNX, SQLite, Voy): CacheFirst (they change very rarely)
          {
            urlPattern: /^\/(ort-wasm|mediapipe|wasm)\/.*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-wasm-runtimes',
              expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          // ONNX WASM helper modules (.mjs / .js inside /ort-wasm/)
          {
            urlPattern: /^\/ort-wasm\/.*\.(js|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-wasm-helpers',
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          // Thumbnails: CacheFirst
          {
            urlPattern: /\/api\/images\/\d+\/thumbnail/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-thumbnails',
              expiration: { maxEntries: 5000, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          // ONNX AI models: CacheFirst
          {
            urlPattern: /^\/models\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-onnx-models',
              expiration: { maxEntries: 10, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          // API always hits network
          { urlPattern: /^\/api\//, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],

  optimizeDeps: {
    exclude: ['onnxruntime-web', 'voy-search'],
  },

  assetsInclude: ['**/*.wasm'],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.CRISP_V4_PORT || 7861}`,
        changeOrigin: true,
        configure: (proxy) => { proxy.on('error', () => {}); },
      },
      '/models': {
        target: `http://127.0.0.1:${process.env.CRISP_V4_PORT || 7861}`,
        changeOrigin: true,
        configure: (proxy) => { proxy.on('error', () => {}); },
      },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
});
