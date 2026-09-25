import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { dialog } from './directives/dialog'

createApp(App).directive('dialog', dialog).mount('#app')
