import type { CapacitorConfig } from '@capacitor/cli';

// When CAPACITOR_SERVER_URL is set (e.g. in CI or mobile dev), the app
// communicates with that remote backend instead of bundled assets.
// For local development against the Node.js server:
//   CAPACITOR_SERVER_URL=http://192.168.x.x:7861 npx cap run ios

const remoteUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.crisplens.app',
  appName: 'CrispLens',
  webDir: 'dist',
  ...(remoteUrl ? { server: { url: remoteUrl, cleartext: true } } : {}),
};

export default config;
