import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  root: resolve(__dirname),
  base: '/admin/',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Single HTML file output for CF Worker embedding
    assetsInlineLimit: 1_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
});
