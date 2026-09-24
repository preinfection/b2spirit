import { defineConfig, type Plugin } from 'vite';

/**
 * Marks module entry scripts as render-blocking (`blocking="render"`).
 *
 * The intro renders its first WebGL frame synchronously while the entry module
 * evaluates, so blocking the first paint on that module means the very first
 * frame the browser ever shows already contains the aircraft: no blank screen,
 * no fade-in, no loading state.
 */
function renderBlockingEntry(): Plugin {
  return {
    name: 'render-blocking-entry',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/<script type="module"(?![^>]*blocking=)/g, '<script type="module" blocking="render"');
    },
  };
}

export default defineConfig({
  // Local-only: bind to loopback and never pick a different port silently.
  server: { host: 'localhost', port: 5173, strictPort: true },
  preview: { host: 'localhost', port: 4173, strictPort: true },
  plugins: [renderBlockingEntry()],
  // three.js dominates the bundle; it is one intentional chunk.
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
});
