import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // three.js alone is ~600 kB minified; one chunk is fine for a single-page sim.
    chunkSizeWarningLimit: 900,
  },
});
