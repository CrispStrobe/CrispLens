import type { CapacitorConfig } from '@capacitor/cli';

// ── Capacitor server modes ────────────────────────────────────────────────────
//
// Mode A — Bundled assets (production / device):
//   npx cap sync                     → app loads from capacitor://localhost
//   User must enter the server URL on first launch.
//
// Mode B — Live server (simulator / LAN dev):
//   CAPACITOR_SERVER_URL=http://localhost:7861 npx cap sync ios
//   → WKWebView loads directly from the v4 Node.js server.
//   → Same-origin: no CORS, session cookies just work, no URL config needed.
//   → npm run sim:ios  (shortcut that does the above + opens Xcode)
//
// Mode C — Vite dev server (hot reload):
//   CAPACITOR_SERVER_URL=http://localhost:5173 npx cap sync ios
//   → npm run dev:ios  (shortcut)
//   → Requires both `npm run dev` and `node server.js` running on the Mac.
//
// Note: In the iOS simulator, localhost resolves to the Mac (same as desktop).
//       On a real device, use the Mac's LAN IP instead (e.g. 192.168.x.x).
//       On Android emulator, use 10.0.2.2 instead of localhost.

const remoteUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.crisplens.app',
  appName: 'CrispLens',
  webDir: 'dist',
  ...(remoteUrl ? { server: { url: remoteUrl, cleartext: true } } : {}),
};

export default config;
