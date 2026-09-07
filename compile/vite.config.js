import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Windows treats Public and public as the same directory; never copy release EXEs as Vite assets.
  publicDir: false,
  base: './',
  build: {
    outDir: 'dist/renderer',
    // Чистить dist/renderer каждую сборку: dist/main и dist/preload (tsc)
    // лежат рядом и не затрагиваются. Без этого старые хешированные бандлы
    // копятся, а ручная чистка уже один раз снесла живой CSS.
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
