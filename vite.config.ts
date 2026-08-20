import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/causal-impact-wasm/' : '/',
  plugins: [svelte()],
  server: {
    host: true,
    allowedHosts: ['mac-studio', 'mac-studio.local'],
  },
})
