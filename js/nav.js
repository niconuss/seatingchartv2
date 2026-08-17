// Nav bar: chart title + table add buttons

import { makeTable } from './store.js';
import { drawTable, SEAT_RADIUS } from './drawTable.js';

const PREVIEW_SIZE = 80; // css px — square drag-preview canvas

/**
 * Standalone (ungrouped) rect-table seat layout, matching the "group of one" case
 * in canvas.js's _computeGroupEndInfo() — needed here since the preview table isn't
 * actually in the store yet, so that computation isn't reachable directly.
 */
function standaloneRectEndInfo(table) {
  const headCount  = Math.min(2, table.headSeats || 0); // per-end count: 0, 1, or 2
  const sideCount  = headCount ? Math.max(0, table.seats - headCount * 2) : table.seats;
  const offset     = headCount * 2;
  const topCount   = Math.ceil(sideCount / 2);
  const botCount   = Math.floor(sideCount / 2);

  const rowStartX  = -table.width / 2 + SEAT_RADIUS;
  const topSpacing = (table.width - SEAT_RADIUS * 2) / Math.max(topCount - 1, 1);
  const botSpacing = (table.width - SEAT_RADIUS * 2) / Math.max(botCount - 1, 1);

  const topSeatX = Array.from({ length: topCount }, (_, i) => (topCount === 1 ? 0 : rowStartX + i * topSpacing));
  const botSeatX = Array.from({ length: botCount }, (_, i) => (botCount === 1 ? 0 : rowStartX + i * botSpacing));

  return {
    showLeftHead:  headCount > 0,
    showRightHead: headCount > 0,
    topSeatX, botSeatX,
    topOffset: offset,
    botOffset: offset + topCount,
  };
}

/** A small offscreen canvas rendering the real table (via drawTable) at drag-preview scale, no name label. */
function buildTablePreviewCanvas(type) {
  const table = makeTable(type, 0, 0);
  table.name = ''; // no title until it's actually dropped

  const bounds = type === 'circle'
    ? { w: (table.width / 2 + SEAT_RADIUS + 4) * 2, h: (table.width / 2 + SEAT_RADIUS + 4) * 2 }
    : { w: table.width, h: table.height + (SEAT_RADIUS + 4) * 2 };

  const scale = Math.min((PREVIEW_SIZE * 0.88) / bounds.w, (PREVIEW_SIZE * 0.88) / bounds.h);

  const dpr    = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width  = PREVIEW_SIZE * dpr;
  canvas.height = PREVIEW_SIZE * dpr;
  canvas.style.cssText = `position:absolute; top:-1000px; left:-1000px; width:${PREVIEW_SIZE}px; height:${PREVIEW_SIZE}px;`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
  ctx.scale(scale, scale);

  const endInfo = type === 'rect' ? standaloneRectEndInfo(table) : undefined;
  drawTable(ctx, table, [], false, endInfo);

  return canvas;
}

export function initNav(store, versionManager) {
  // Chart title (contenteditable)
  const titleEl = document.getElementById('chart-title');
  titleEl.textContent = store.chartTitle;

  titleEl.addEventListener('blur', () => {
    const name = titleEl.textContent.trim();
    if (name && name !== store.chartTitle) {
      store.mutate(s => { s.title = name; });
    } else {
      titleEl.textContent = store.chartTitle;
    }
  });

  titleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  });

  store.subscribe(s => {
    if (document.activeElement !== titleEl) {
      titleEl.textContent = s.title;
    }
  });

  // Table add buttons — click to add at center, drag to drop
  const btnTypes = [
    { id: 'btn-add-circle',     type: 'circle'     },
    { id: 'btn-add-rect',       type: 'rect'       },
    { id: 'btn-add-sweetheart', type: 'sweetheart' },
  ];

  // We need the canvas reference — it's wired up via app.js after this runs,
  // so use a lazy lookup from window._sc which app.js sets.
  for (const { id, type } of btnTypes) {
    const btn = document.getElementById(id);

    btn.addEventListener('click', () => {
      window._sc?.canvas.addTable(type);
    });

    btn.addEventListener('dragstart', e => {
      e.dataTransfer.setData('tableType', type);
      e.dataTransfer.effectAllowed = 'copy';

      // Drag a small live render of the real table (via drawTable) instead of the button icon.
      const preview = buildTablePreviewCanvas(type);
      document.body.appendChild(preview);
      e.dataTransfer.setDragImage(preview, PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
      setTimeout(() => preview.remove(), 0);
    });
  }
}
