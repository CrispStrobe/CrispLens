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
          // Vite's assetsInclude:['**/*.wasm'] rewrites the static import in voy_search.js
          // to a URL namespace; __wbg_set_wasm then receives a URL string instead of the
          // module exports, leaving wasm.voy_new undefined. LocalAdapter._getVoyIndex()
          // works around this by manually fetching the binary from this known path and
          // calling WebAssembly.instantiate() to inject the real exports.
          src: 'node_modules/voy-search/voy_search_bg.wasm',
          dest: 'assets',
        },
        {
          // MediaPipe tasks-vision WASM runtime — served from /mediapipe/ so
          // FaceEngineWeb.js can use FilesetResolver.forVisionTasks('/mediapipe/')
          // without hitting an external CDN (works offline / on LAN).
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
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff,woff2,mjs}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10MB
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/api\//, 
          /^\/models\//, 
          /^\/ort-wasm\//, 
          /^\/wasm\//, 
          /^\/assets\//,
          /\.(js|mjs|wasm|css|png|jpg|jpeg|gif|svg|ico|json)$/
        ],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          // JS/CSS app bundles: NetworkFirst so new builds load immediately without
          // requiring SW unregistration. Files have no content hashes so CacheFirst
          // would serve stale bundles indefinitely after an update.
          {
            urlPattern: /\/assets\/.*\.(js|css)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'crisplens-app-bundles',
              networkTimeoutSeconds: 4,
            },
          },
          // Thumbnails: CacheFirst — automatically cached as user browses (enables offline gallery)
          {
            urlPattern: /\/api\/images\/\d+\/thumbnail/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-thumbnails',
              expiration: { maxEntries: 5000, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: /^\/ort-wasm\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-wasm-assets',
              expiration: { maxEntries: 50 },
            },
          },
          { urlPattern: /^\/api\//, handler: 'NetworkOnly' },
          // ONNX models: cache-first after first download (very large, rarely change)
          {
            urlPattern: /^\/models\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crisplens-onnx-models',
              expiration: { maxEntries: 10 },
            },
          },
        ],
      },
    }),
  ],

  // Exclude pre-built WASM packages from Vite's esbuild optimizer.
  // These packages manage their own WASM initialization; bundling them breaks it.
  optimizeDeps: {
    exclude: ['onnxruntime-web', 'voy-search'],
  },

  // Treat .wasm files as assets so Rollup doesn't try to parse them
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
    // Disable hashing for predictable filenames (fixes dynamic import issues on some hosts)
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
});
