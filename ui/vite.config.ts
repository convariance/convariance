import { defineConfig } from 'vite'

// BASE_PATH lets the GitHub Pages workflow build for a project-site prefix
// (e.g. /convariance/); local dev and plain hosts default to '/'.
export default defineConfig({
  base: process.env.BASE_PATH || '/'
})
