import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // BASE_PATH overrides the base for deploys under a sub-path elsewhere
  // (alphabeta.tools/lab/pre-post/); GITHUB_PAGES keeps its own default.
  base: process.env.BASE_PATH ?? (process.env.GITHUB_PAGES ? '/causal-impact-wasm/' : '/'),
  plugins: [svelte()],
  server: {
    host: true,
    allowedHosts: ['mac-studio', 'mac-studio.local'],
  },
})
