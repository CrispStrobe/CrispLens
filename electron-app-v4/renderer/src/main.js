import App from './App.svelte';
import { defineCustomElements } from 'jeep-sqlite/loader';

async function init() {
  console.log('[main] init started');
  const isWeb = window.location.protocol !== 'capacitor:';
  
  if (isWeb) {
    console.log('[main] Web platform detected. Initializing jeep-sqlite...');
    try {
      defineCustomElements(window);
      
      // Ensure jeep-sqlite is in the DOM
      let jeepSqlite = document.querySelector('jeep-sqlite');
      if (!jeepSqlite) {
        console.log('[main] Creating jeep-sqlite element...');
        jeepSqlite = document.createElement('jeep-sqlite');
        jeepSqlite.setAttribute('auto-save', 'true');
        document.body.appendChild(jeepSqlite);
      }
      
      console.log('[main] Waiting for custom elements to be defined...');
      await customElements.whenDefined('jeep-sqlite');
      
      // Critical: wait for the component to be fully ready
      // CapacitorSQLite web implementation relies on this.
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('[main] jeep-sqlite is ready in DOM');
    } catch (err) {
      console.error('[main] jeep-sqlite initialization failed:', err);
    }
  }
  
  console.log('[main] Starting Svelte app...');
  const app = new App({ target: document.getElementById('app') });
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export default {};
