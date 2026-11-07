const { defineConfig } = require('vite')
const react = require('@vitejs/plugin-react').default

module.exports = defineConfig({
  plugins: [react()],
  // Never copy release EXEs as Vite assets.
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