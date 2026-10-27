import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two separate single-page apps share one build and one set of UI components:
//   /          Admin Console
//   /testing/  Testing and Simulation app
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4000' } },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { input: { admin: resolve(__dirname, 'index.html'), testing: resolve(__dirname, 'testing/index.html') } },
  },
});
