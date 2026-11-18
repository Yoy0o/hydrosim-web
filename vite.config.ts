import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // relative to the project root (run `npm run build` from this folder)
      input: {
        main: 'index.html',
        // WebGPU engine validation / benchmark page
        gpuTest: 'gpu-test.html',
      },
    },
  },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
});
