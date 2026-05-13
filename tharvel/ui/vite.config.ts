import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
// `base` corrisponde al path su cui l'app è montata sul dominio del sito cliente
// (vedi server/index.ts, stesso prefisso). Vite usa questo valore per prefixare
// gli URL degli asset nell'HTML emesso, così `/tharveladmin/assets/...` viene
// risolto dal browser sul backend Tharvel invece che cadere sul sito del cliente.
export default defineConfig({
  base: '/tharveladmin/',
  plugins: [vue()],
})
