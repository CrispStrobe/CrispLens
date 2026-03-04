import App from './App.svelte';
import { defineCustomElements } from 'jeep-sqlite/loader';

async function init() {
  console.log('[main] init started');
  
  // We initialize jeep-sqlite if we are in a browser-like environment (including Capacitor).
  // The 'capacitor://' protocol on iOS/Android behaves like a web origin.
  // We ALWAYS define custom elements to ensure standalone mode works after a switch.
  console.log('[main] Initializing jeep-sqlite component...');
  try {
    // 1. Define custom elements
    defineCustomElements(window);
    
    // 2. Ensure the element exists in the DOM
    let jeepSqlite = document.querySelector('jeep-sqlite');
    if (!jeepSqlite) {
      console.log('[main] Creating and appending jeep-sqlite element...');
      jeepSqlite = document.createElement('jeep-sqlite');
      jeepSqlite.setAttribute('auto-save', 'true');
      document.body.appendChild(jeepSqlite);
    }
    
    // 3. Wait for the component to be defined AND upgraded
    await customElements.whenDefined('jeep-sqlite');
    
    // Small delay to allow the Stencil component to initialize its internal shadow DOM
    await new Promise(resolve => setTimeout(resolve, 300));
    
    if (jeepSqlite.shadowRoot) {
      console.log('[main] jeep-sqlite is fully upgraded and ready');
    } else {
      console.warn('[main] jeep-sqlite element defined but shadowRoot missing. Persistence might be limited.');
    }
  } catch (err) {
    console.error('[main] jeep-sqlite initialization failed:', err);
  }
  
  console.log('[main] Starting Svelte app...');
  const app = new App({ target: document.getElementById('app') });
}

// Ensure init runs after the DOM is fully interactive
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export default {};
