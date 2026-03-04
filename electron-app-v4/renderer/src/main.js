import App from './App.svelte';
import { defineCustomElements } from 'jeep-sqlite/loader';

async function init() {
  if (window.location.protocol !== 'capacitor:') {
    // Only needed for web browser mode
    defineCustomElements(window);
    
    // Wait for the custom element to be defined
    await customElements.whenDefined('jeep-sqlite');
    
    console.log('[main] jeep-sqlite ready');
  }
  
  const app = new App({ target: document.getElementById('app') });
}

init();

export default {};
