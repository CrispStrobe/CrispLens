import App from './App.svelte';
import { defineCustomElements } from 'jeep-sqlite/loader';

async function init() {
  const isWeb = window.location.protocol !== 'capacitor:';
  
  if (isWeb) {
    console.log('[main] Browser mode detected. Initializing jeep-sqlite...');
    try {
      defineCustomElements(window);
      await customElements.whenDefined('jeep-sqlite');
      
      // Create and append the element if not already present
      if (!document.querySelector('jeep-sqlite')) {
        const jeepSqlite = document.createElement('jeep-sqlite');
        jeepSqlite.setAttribute('auto-save', 'true');
        document.body.appendChild(jeepSqlite);
      }
      
      console.log('[main] jeep-sqlite ready');
    } catch (err) {
      console.error('[main] jeep-sqlite initialization failed:', err);
    }
  }
  
  const app = new App({ target: document.getElementById('app') });
}

init();

export default {};
