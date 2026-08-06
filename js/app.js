import { Store } from './store.js';
import { Canvas } from './canvas.js';
import { SidePanel } from './sidePanel.js';
import { VersionManager } from './versions.js';
import { initNav } from './nav.js';

// ── Bootstrap ──────────────────────────────────────────────────────────────

// Resolve chart ID from URL hash; create one if absent
function getOrCreateChartId() {
  let id = location.hash.slice(1);
  if (!id) {
    id = crypto.randomUUID();
    history.replaceState(null, '', `#${id}`);
  }
  return id;
}

const chartId = getOrCreateChartId();
const store = new Store(chartId);
const canvas = new Canvas(document.getElementById('main-canvas'), store);
const sidePanel = new SidePanel(store, canvas);
const versionManager = new VersionManager(store, canvas);

initNav(store, versionManager);

// The side panel, version list, and nav all subscribe to the store and redraw
// themselves automatically once Firestore data lands. The canvas doesn't auto-subscribe
// (it renders explicitly, to avoid redrawing on every intermediate drag update), so give
// it one explicit refresh once the initial sync (local vs. remote reconciliation) settles.
store.ready.then(() => {
  canvas._fitToContent();
  canvas.render();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    store.undo();
    canvas.render();
    sidePanel.refresh();
  }
});

// Expose globals for debugging during dev
window._sc = { store, canvas, sidePanel, versionManager };
