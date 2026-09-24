import '@fontsource/outfit/400.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/800.css';
import './styles/site.css';
import { playIntro } from './intro';

const params = new URLSearchParams(location.search);
const root = document.getElementById('intro');
const page = document.getElementById('app');

if (import.meta.env.DEV && params.get('view') === 'model') {
  const { startModelViewer } = await import('./debug/modelViewer');
  startModelViewer();
} else if (import.meta.env.DEV && params.has('capture') && root) {
  // Frame-accurate capture for validation: nothing plays, frames render on demand.
  const { startCapture } = await import('./debug/capture');
  startCapture(root, page);
} else if (root) {
  // Warm the wordmark face so it is ready long before it appears (~2.4 s in).
  document.fonts?.load('800 1em Outfit').catch(() => {});
  playIntro({ root, page, force: params.get('intro') === 'force' });
}
