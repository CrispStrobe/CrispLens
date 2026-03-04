import App from './App.svelte';
import { defineCustomElements as defineJeepSqlite } from 'jeep-sqlite/loader';

async function init() {
  if (window.location.protocol !== 'capacitor:') {
    // Only needed for web browser mode
    defineJeepSqlite(window);
  }
  
  const app = new App({ target: document.getElementById('app') });
}

init();

export default {};
