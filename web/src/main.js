import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { restoreCatalog } from './catalog.js'
restoreCatalog().then(() => createApp(App).mount('#app'))
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load',() => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`,{scope:import.meta.env.BASE_URL}).catch(() => {}))
}
