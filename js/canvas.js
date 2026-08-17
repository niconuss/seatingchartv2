// Canvas renderer and interaction handler

import { makeTable } from './store.js';
import { drawTable, drawGroupHighlight, drawFloatingGuest, drawSeat, getFloatingGuestBounds, buildFloatingGuestDragImage, getRotateHandleWorld, getSeatPositions, SEAT_RADIUS } from './drawTable.js';
import { TableToolbar } from './tableToolbar.js';

const GRID_SIZE     = 40;
const MIN_ZOOM      = 0.25;
const MAX_ZOOM      = 3;
const CONJOIN_THRESH = 36;  // world px — snap-to-touch range (covers the ~20px grid gap)

export class Canvas {
  constructor(el, store) {
    this.el    = el;
    this.store = store;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this._selected  = null;   // tableId
    this._dragging  = null;
    this._panning   = null;
    this._rotating  = null;

    this._pendingGuestDrag   = null; // { guestId } — mousedown on an occupied seat or a floating guest, waiting to see if it becomes a real drag
    this._guestDragHoverSeat = null; // { tableId, seatIndex } | null — seat under the cursor during a guest drag, for the live highlight

    this._selectedFloatingGuests = new Set(); // guestIds selected via click or marquee — shows the remove ("x") badge, Delete removes them all
    this._marquee         = null; // { startX, startY, endX, endY } in css px — active rubber-band selection
    this._floatingGroupDrag = null; // custom (non-native) drag for moving a multi-selection of floating guests together

    this._seatAnimation = null; // guest displaced by a swap, animating from their old seat to wherever they end up

    this._resize();
    this._fitToContent();
    this._toolbar = new TableToolbar(this, store);
    this._bindEvents();
    this._initZoomLabelEdit();
    this.render();
    this._updateZoomLabel();

    new ResizeObserver(() => { this._resize(); this.render(); }).observe(el);
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  _resize() {
    const rect = this.el.getBoundingClientRect();
    this.el.width  = rect.width  * devicePixelRatio;
    this.el.height = rect.height * devicePixelRatio;
    this.cssWidth  = rect.width;
    this.cssHeight = rect.height;
  }

  /**
   * Frames the current version's tables and floating guests on load, since zoom/pan
   * aren't persisted. Leaves a generous safe area on the left so nothing lands under
   * the floating side panel, and on the bottom so it clears the table-add button row.
   * Never zooms in past 100% just because the content is small — only zooms out if
   * needed to fit everything.
   */
  _fitToContent() {
    const tables = this.store.tables;
    const floatingGuests = this.store.currentVersion?.floatingGuests ?? {};
    const floatingIds = Object.keys(floatingGuests);
    if (!tables.length && !floatingIds.length) return;

    const PAD = 70; // world px — clears seats, name label, and rotate handle
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tables) {
      const hw = t.width / 2 + PAD;
      const hh = (t.type === 'circle' ? t.width : t.height) / 2 + PAD;
      minX = Math.min(minX, t.x - hw);
      maxX = Math.max(maxX, t.x + hw);
      minY = Math.min(minY, t.y - hh);
      maxY = Math.max(maxY, t.y + hh);
    }

    const FLOATING_PAD = 60; // covers a typical floating-guest chip's half-width
    for (const id of floatingIds) {
      const pos = floatingGuests[id];
      minX = Math.min(minX, pos.x - FLOATING_PAD);
      maxX = Math.max(maxX, pos.x + FLOATING_PAD);
      minY = Math.min(minY, pos.y - FLOATING_PAD);
      maxY = Math.max(maxY, pos.y + FLOATING_PAD);
    }

    const bboxW  = maxX - minX;
    const bboxH  = maxY - minY;
    const bboxCx = (minX + maxX) / 2;
    const bboxCy = (minY + maxY) / 2;

    const panelEl  = document.getElementById('side-panel');
    const wrapRect = this.el.parentElement.getBoundingClientRect();
    const leftInset = panelEl
      ? Math.max(0, panelEl.getBoundingClientRect().right - wrapRect.left) + 24
      : 24;
    const rightPad  = 24;
    const topPad    = 24;
    const bottomPad = 120; // clears the table-add buttons row

    const availW = Math.max(100, this.cssWidth  - leftInset - rightPad);
    const availH = Math.max(100, this.cssHeight - topPad    - bottomPad);

    const fitZoom = Math.min(availW / bboxW, availH / bboxH);
    this.zoom = Math.min(1, Math.max(MIN_ZOOM, fitZoom)); // cap at 100% — never zoom in just because content is small

    const availCx = leftInset + availW / 2;
    const availCy = topPad + availH / 2;
    this.panX = availCx - bboxCx * this.zoom;
    this.panY = availCy - bboxCy * this.zoom;
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  toWorld(cx, cy) {
    return { x: (cx - this.panX) / this.zoom, y: (cy - this.panY) / this.zoom };
  }

  toScreen(wx, wy) {
    return { x: wx * this.zoom + this.panX, y: wy * this.zoom + this.panY };
  }

  snapToGrid(v) { return Math.round(v / GRID_SIZE) * GRID_SIZE; }

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    const ctx = this.el.getContext('2d');
    const dpr = devicePixelRatio;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#f7f7f7';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    this._drawGrid(ctx);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    const endInfo = this._computeGroupEndInfo();

    // Draw group highlights beneath tables
    const groups = this._getGroupedTableSets();
    for (const members of groups) drawGroupHighlight(ctx, members);

    // A guest mid-swap-animation is hidden from their normal (already-updated) spot
    // and drawn separately below, traveling from where they used to be.
    const guestsForRender = this._seatAnimation
      ? this.store.guests.filter(g => g.id !== this._seatAnimation.guestId)
      : this.store.guests;

    for (const table of this.store.tables) {
      drawTable(ctx, table, guestsForRender, table.id === this._selected, endInfo[table.id]);
    }

    const floatingGuests = this.store.currentVersion?.floatingGuests ?? {};
    for (const [guestId, pos] of Object.entries(floatingGuests)) {
      if (this._seatAnimation?.guestId === guestId) continue;
      const guest = this.store.guests.find(g => g.id === guestId);
      if (guest) drawFloatingGuest(ctx, pos.x, pos.y, guest, this._selectedFloatingGuests.has(guestId));
    }

    if (this._seatAnimation) this._drawSeatSwapGhost(ctx, endInfo);

    if (this._guestDragHoverSeat) this._drawSeatHighlight(ctx, endInfo);

    ctx.restore();

    if (this._marquee) this._drawMarquee(ctx);

    ctx.restore();

    this._toolbar.updatePosition();
  }

  _drawMarquee(ctx) {
    const { startX, startY, endX, endY } = this._marquee;
    const x = Math.min(startX, endX), y = Math.min(startY, endY);
    const w = Math.abs(endX - startX), h = Math.abs(endY - startY);

    ctx.save();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 1.3;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawGrid(ctx) {
    const spacing = GRID_SIZE * this.zoom;
    const offsetX = ((this.panX % spacing) + spacing) % spacing;
    const offsetY = ((this.panY % spacing) + spacing) % spacing;

    ctx.fillStyle = '#cecece';
    // Dots shrink as you zoom out (and grow slightly zoomed in), floored so they never vanish.
    const dotR = Math.min(3, Math.max(0.6, 1.5 * this.zoom));

    for (let x = offsetX; x < this.cssWidth; x += spacing) {
      for (let y = offsetY; y < this.cssHeight; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  _hitTable(wx, wy) {
    const tables = this.store.tables;
    for (let i = tables.length - 1; i >= 0; i--) {
      if (this._pointInTable(wx, wy, tables[i])) return tables[i];
    }
    return null;
  }

  _pointInTable(wx, wy, t) {
    const cos = Math.cos(-t.rotation), sin = Math.sin(-t.rotation);
    const dx = wx - t.x, dy = wy - t.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    if (t.type === 'circle') {
      const r = t.width / 2;
      return lx * lx + ly * ly <= r * r;
    }
    return Math.abs(lx) <= t.width / 2 && Math.abs(ly) <= t.height / 2;
  }

  _hitRotateHandle(wx, wy, table) {
    const h = getRotateHandleWorld(table);
    const dx = wx - h.x, dy = wy - h.y;
    return dx * dx + dy * dy <= (10 / this.zoom) * (10 / this.zoom);
  }

  /** World-space position of a specific seat, or null if the table/seat no longer exists. */
  _seatWorldPos(tableId, seatIndex) {
    const table = this.store.tables.find(t => t.id === tableId);
    if (!table) return null;
    const endInfo = this._computeGroupEndInfo();
    const pos = getSeatPositions(table, endInfo[tableId])
      .find(p => String(p.seatIndex) === String(seatIndex));
    if (!pos) return null;
    const cos = Math.cos(table.rotation), sin = Math.sin(table.rotation);
    return { x: table.x + pos.x * cos - pos.y * sin, y: table.y + pos.x * sin + pos.y * cos };
  }

  /**
   * Finds the seat at a given world point, if any. Reuses getSeatPositions() —
   * the same function drawTable.js uses to place seats — so the hit target can
   * never drift out of alignment with what's actually drawn.
   */
  _hitTestSeat(wx, wy) {
    const endInfo   = this._computeGroupEndInfo();
    const threshold = SEAT_RADIUS + 4;

    for (const table of this.store.tables) {
      const cos = Math.cos(-table.rotation), sin = Math.sin(-table.rotation);
      const dx = wx - table.x, dy = wy - table.y;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;

      for (const pos of getSeatPositions(table, endInfo[table.id])) {
        const ddx = lx - pos.x, ddy = ly - pos.y;
        if (ddx * ddx + ddy * ddy <= threshold * threshold) {
          return { tableId: table.id, seatIndex: pos.seatIndex };
        }
      }
    }
    return null;
  }

  _isOccupiedSeat(wx, wy) {
    const hit = this._hitTestSeat(wx, wy);
    if (!hit) return false;
    const table = this.store.tables.find(t => t.id === hit.tableId);
    return !!table?.seatAssignments[hit.seatIndex];
  }

  /**
   * Returns the guestId of the floating (parked-outside-a-seat) guest at this world
   * point, if any — tests the whole chip's bounds (avatar + name + padding), not
   * just the avatar circle, so you can grab it anywhere.
   */
  _hitTestFloatingGuest(wx, wy) {
    const floating = this.store.currentVersion?.floatingGuests ?? {};
    const ids = Object.keys(floating);
    if (!ids.length) return null;
    const ctx = this.el.getContext('2d');
    for (const guestId of ids) {
      const guest = this.store.guests.find(g => g.id === guestId);
      if (!guest) continue;
      const pos = floating[guestId];
      const b = getFloatingGuestBounds(ctx, pos.x, pos.y, guest);
      if (wx >= b.left && wx <= b.right && wy >= b.top && wy <= b.bottom) return guestId;
    }
    return null;
  }

  /** True if `wx,wy` lands on the remove ("x") badge of a currently-selected floating guest. */
  _hitTestFloatingGuestBadge(wx, wy, guestId) {
    const pos = this.store.currentVersion?.floatingGuests?.[guestId];
    const guest = this.store.guests.find(g => g.id === guestId);
    if (!pos || !guest) return false;
    const ctx = this.el.getContext('2d');
    const b = getFloatingGuestBounds(ctx, pos.x, pos.y, guest);
    const dx = wx - b.right, dy = wy - b.top;
    return dx * dx + dy * dy <= 10 * 10; // a little more forgiving than the badge's own radius
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    const el = this.el;
    el.addEventListener('mousedown', e => this._onMouseDown(e));
    el.addEventListener('click',     e => this._onCanvasClick(e));
    el.addEventListener('dblclick',  e => this._onDblClick(e));
    el.addEventListener('wheel',     e => this._onWheel(e), { passive: false });
    el.addEventListener('dragover',  e => this._onDragOver(e));
    el.addEventListener('dragleave', () => this._clearGuestDragHighlight());
    el.addEventListener('drop',      e => this._onDrop(e));
    el.addEventListener('dragstart', e => this._onCanvasDragStart(e));
    el.addEventListener('dragend',   () => this._onCanvasDragEnd());

    document.addEventListener('mousemove', e => this._onMouseMove(e));
    document.addEventListener('mouseup',   e => this._onMouseUp(e));

    document.getElementById('btn-zoom-in') .addEventListener('click', () =>
      this._applyZoom(Math.min(MAX_ZOOM, this.zoom * 1.25)));
    document.getElementById('btn-zoom-out').addEventListener('click', () =>
      this._applyZoom(Math.max(MIN_ZOOM, this.zoom / 1.25)));

    document.addEventListener('keydown', e => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    // Don't fire when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

    if (this._selectedFloatingGuests.size > 0) {
      if (e.key === 'Escape') {
        this._selectedFloatingGuests.clear();
        this.render();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this._removeFloatingGuests([...this._selectedFloatingGuests]);
        return;
      }
    }

    if (!this._selected) return;

    if (e.key === 'Escape') {
      this._selected = null;
      this._toolbar.hide();
      this.render();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const id = this._selected;
      this._selected = null;
      this._toolbar.hide();
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables = v.tables.filter(t => t.id !== id);
      });
      this.render();
      return;
    }

    const STEP = Math.PI / 12; // 15°
    if (e.key === '[') { e.preventDefault(); this._toolbar._rotate(-STEP); }
    if (e.key === ']') { e.preventDefault(); this._toolbar._rotate( STEP); }
  }

  _cssPos(e) {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Mouse events ──────────────────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      const { x, y } = this._cssPos(e);
      this._panning = { startX: x, startY: y, origPanX: this.panX, origPanY: this.panY };
      this.el.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    const { x, y } = this._cssPos(e);
    const w = this.toWorld(x, y);

    // Check rotate handle first (only when a table is already selected)
    if (this._selected) {
      const selTable = this.store.tables.find(t => t.id === this._selected);
      if (selTable && this._hitRotateHandle(w.x, w.y, selTable)) {
        this._rotating = {
          tableId:      selTable.id,
          groupId:      selTable.conjoinGroupId,
          cx:           selTable.x,
          cy:           selTable.y,
          startAngle:   Math.atan2(w.y - selTable.y, w.x - selTable.x),
          origRotation: selTable.rotation,
          // For groups, store each table's orig rotation and position
          groupSnap:    this._captureGroupSnap(selTable.conjoinGroupId),
        };
        this.el.style.cursor = 'crosshair';
        return;
      }
    }

    // Clicking a selected floating guest's remove badge shouldn't also start a drag —
    // let it fall through to the click handler untouched.
    for (const guestId of this._selectedFloatingGuests) {
      if (this._hitTestFloatingGuestBadge(w.x, w.y, guestId)) return;
    }

    // A seated or floating guest under the cursor takes over as a native drag instead of a table interaction.
    const seatHit = this._hitTestSeat(w.x, w.y);
    const seatTable = seatHit ? this.store.tables.find(t => t.id === seatHit.tableId) : null;
    const seatGuestId = seatTable?.seatAssignments[seatHit?.seatIndex];
    const floatingGuestId = seatGuestId ? null : this._hitTestFloatingGuest(w.x, w.y);

    if (floatingGuestId && this._selectedFloatingGuests.size > 1 && this._selectedFloatingGuests.has(floatingGuestId)) {
      // Multiple floating guests selected via marquee — move the whole group together.
      const positions = {};
      for (const gid of this._selectedFloatingGuests) {
        const p = this.store.currentVersion?.floatingGuests?.[gid];
        if (p) positions[gid] = { x: p.x, y: p.y };
      }
      this._floatingGroupDrag = { startX: x, startY: y, positions, moved: false };
      return;
    }

    const dragGuestId = seatGuestId || floatingGuestId;
    if (dragGuestId) {
      this._pendingGuestDrag = { guestId: dragGuestId };
      this.el.draggable = true;
      return;
    }
    this.el.draggable = false;
    this._pendingGuestDrag = null;

    const hit = this._hitTable(w.x, w.y);

    if (hit) {
      this._selected = hit.id;
      this._toolbar.show(hit.id);
      this._selectedFloatingGuests.clear();

      const groupPositions = this._captureGroupSnap(hit.conjoinGroupId);

      this._dragging = {
        tableId:        hit.id,
        groupId:        hit.conjoinGroupId,
        startX: x,     startY: y,
        origX:  hit.x, origY:  hit.y,
        groupPositions,
        moved:          false,
      };
      this.el.style.cursor = 'grabbing';
    } else if (e.shiftKey) {
      // Shift+drag on empty canvas: start a marquee selection for floating guests.
      this._selected = null;
      this._toolbar.hide();
      this._selectedFloatingGuests.clear();
      this._marquee = { startX: x, startY: y, endX: x, endY: y };
    } else {
      this._selected = null;
      this._toolbar.hide();
      this._selectedFloatingGuests.clear();
      this._panning = { startX: x, startY: y, origPanX: this.panX, origPanY: this.panY };
      this.el.style.cursor = 'grabbing';
    }

    this.render();
  }

  _captureGroupSnap(groupId) {
    if (!groupId) return null;
    const snap = {};
    this.store.tables
      .filter(t => t.conjoinGroupId === groupId)
      .forEach(t => { snap[t.id] = { x: t.x, y: t.y, rotation: t.rotation }; });
    return snap;
  }

  _onMouseMove(e) {
    const { x, y } = this._cssPos(e);
    const w = this.toWorld(x, y);

    // Update cursor for hover affordances (rotate handle, draggable table, draggable seated guest)
    if (!this._dragging && !this._panning && !this._rotating && !this._pendingGuestDrag && !this._marquee && !this._floatingGroupDrag) {
      const sel = this._selected ? this.store.tables.find(t => t.id === this._selected) : null;

      if (sel && this._hitRotateHandle(w.x, w.y, sel)) {
        this.el.style.cursor = 'crosshair';
      } else if (this._isOccupiedSeat(w.x, w.y) || this._hitTestFloatingGuest(w.x, w.y)) {
        this.el.style.cursor = 'grab';
      } else if (sel && this._pointInTable(w.x, w.y, sel)) {
        this.el.style.cursor = 'grab';
      } else {
        this.el.style.cursor = 'default';
      }
    }

    if (this._panning) {
      const dx = x - this._panning.startX;
      const dy = y - this._panning.startY;
      this.panX = this._panning.origPanX + dx;
      this.panY = this._panning.origPanY + dy;
      this.render();
      return;
    }

    if (this._marquee) {
      this._marquee.endX = x;
      this._marquee.endY = y;

      const a = this.toWorld(this._marquee.startX, this._marquee.startY);
      const b = this.toWorld(x, y);
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

      const floating = this.store.currentVersion?.floatingGuests ?? {};
      const selected = new Set();
      for (const [guestId, pos] of Object.entries(floating)) {
        if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) selected.add(guestId);
      }
      this._selectedFloatingGuests = selected;
      this.render();
      return;
    }

    if (this._floatingGroupDrag) {
      const dx = (x - this._floatingGroupDrag.startX) / this.zoom;
      const dy = (y - this._floatingGroupDrag.startY) / this.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._floatingGroupDrag.moved = true;

      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (!v.floatingGuests) return;
        for (const [guestId, orig] of Object.entries(this._floatingGroupDrag.positions)) {
          if (v.floatingGuests[guestId]) {
            v.floatingGuests[guestId] = { x: orig.x + dx, y: orig.y + dy };
          }
        }
      }, { silent: true });

      this.render();
      return;
    }

    if (this._rotating) {
      const { cx, cy, startAngle, origRotation, groupId, groupSnap, tableId } = this._rotating;
      const angle = Math.atan2(w.y - cy, w.x - cx);
      const rawDelta = angle - startAngle;
      const SNAP = Math.PI / 12; // 15°
      const delta = Math.round(rawDelta / SNAP) * SNAP;

      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (groupId && groupSnap) {
          // Rotate group around center
          const cos = Math.cos(delta), sin = Math.sin(delta);
          v.tables.forEach(t => {
            if (t.conjoinGroupId !== groupId) return;
            const orig = groupSnap[t.id];
            if (!orig) return;
            const dx = orig.x - cx, dy = orig.y - cy;
            t.x = cx + dx * cos - dy * sin;
            t.y = cy + dx * sin + dy * cos;
            t.rotation = (orig.rotation + delta + Math.PI * 2) % (Math.PI * 2);
          });
        } else {
          const t = v.tables.find(t => t.id === tableId);
          if (t) t.rotation = (origRotation + delta + Math.PI * 2) % (Math.PI * 2);
        }
      }, { silent: true });

      this.render();
      return;
    }

    if (this._dragging) {
      const dx = (x - this._dragging.startX) / this.zoom;
      const dy = (y - this._dragging.startY) / this.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._dragging.moved = true;

      const snapDx = this.snapToGrid(this._dragging.origX + dx) - this._dragging.origX;
      const snapDy = this.snapToGrid(this._dragging.origY + dy) - this._dragging.origY;

      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (this._dragging.groupId && this._dragging.groupPositions) {
          // Move whole group
          v.tables.forEach(t => {
            if (t.conjoinGroupId !== this._dragging.groupId) return;
            const orig = this._dragging.groupPositions[t.id];
            if (orig) { t.x = orig.x + snapDx; t.y = orig.y + snapDy; }
          });
        } else {
          const t = v.tables.find(t => t.id === this._dragging.tableId);
          if (t) {
            t.x = this.snapToGrid(this._dragging.origX + dx);
            t.y = this.snapToGrid(this._dragging.origY + dy);
          }
        }
      }, { silent: true });

      this.render();
    }
  }

  _onMouseUp() {
    if (this._marquee) {
      this._marquee = null;
      this.render();
      return;
    }

    if (this._floatingGroupDrag) {
      if (this._floatingGroupDrag.moved) {
        const liveFloating = this.store.currentVersion?.floatingGuests ?? {};
        const guestIds = Object.keys(this._floatingGroupDrag.positions);
        this.store.mutate(s => {
          const v = s.versions.find(v => v.id === s.currentVersionId);
          if (!v.floatingGuests) return;
          for (const guestId of guestIds) {
            if (liveFloating[guestId]) v.floatingGuests[guestId] = { ...liveFloating[guestId] };
          }
        });
      }
      this._floatingGroupDrag = null;
      return;
    }

    if (this._rotating) {
      const { tableId, groupId, groupSnap } = this._rotating;
      const tables = this.store.tables;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (groupId && groupSnap) {
          v.tables.forEach(t => {
            if (t.conjoinGroupId !== groupId) return;
            const live = tables.find(l => l.id === t.id);
            if (live) { t.x = live.x; t.y = live.y; t.rotation = live.rotation; }
          });
        } else {
          const live = tables.find(l => l.id === tableId);
          const t = v.tables.find(t => t.id === tableId);
          if (t && live) t.rotation = live.rotation;
        }
      });
      this._toolbar._sync();
      this._rotating = null;
      this.el.style.cursor = 'default';
      this.render();
      return;
    }

    if (this._dragging?.moved) {
      const { tableId, groupId, groupPositions } = this._dragging;
      const tables = this.store.tables;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (groupId && groupPositions) {
          v.tables.forEach(t => {
            if (t.conjoinGroupId !== groupId) return;
            const live = tables.find(l => l.id === t.id);
            if (live) { t.x = live.x; t.y = live.y; }
          });
        } else {
          const live = tables.find(l => l.id === tableId);
          const t = v.tables.find(t => t.id === tableId);
          if (t && live) { t.x = live.x; t.y = live.y; }
        }
      });
      // Conjoin check for single rect tables or group members
      this._detectConjoin(tableId);
    }

    this._dragging = null;
    this._panning  = null;
    this.el.style.cursor = 'default';
  }

  // ── Group helpers ─────────────────────────────────────────────────────────

  /** Returns array of table-arrays, one per conjoin group (size ≥ 2). */
  _getGroupedTableSets() {
    const map = {};
    for (const t of this.store.tables) {
      if (!t.conjoinGroupId) continue;
      (map[t.conjoinGroupId] = map[t.conjoinGroupId] || []).push(t);
    }
    return Object.values(map).filter(g => g.length >= 2);
  }

  /**
   * Returns a map of tableId → { showLeftHead, showRightHead, topSeatX, botSeatX, topOffset, botOffset }
   * for all rect tables. Populated for both standalone tables and conjoined groups.
   *
   * Groups only ever chain short-end to short-end (see _detectConjoin), so a group is
   * always a straight horizontal run. Seat x-positions are computed once across the
   * whole run so spacing is uniform across every table in the group, not per-table —
   * a standalone table is just treated as a group of one.
   */
  _computeGroupEndInfo() {
    const endInfo = {};
    const tables  = this.store.tables;
    const groups  = {};

    for (const t of tables) {
      if (t.type !== 'rect') continue;
      const key = t.conjoinGroupId ?? t.id;
      (groups[key] = groups[key] || []).push(t);
    }

    for (const members of Object.values(groups)) {
      const sorted    = [...members].sort((a, b) => a.x - b.x);
      const headCount = Math.min(2, sorted[0].headSeats || 0); // per-end count, uniform across a group

      const groupLeft  = Math.min(...sorted.map(m => m.x - m.width / 2));
      const groupRight = Math.max(...sorted.map(m => m.x + m.width / 2));
      const groupWidth = groupRight - groupLeft;

      const alloc = sorted.map((m, i) => {
        const isLeft  = i === 0;
        const isRight = i === sorted.length - 1;
        if (headCount) {
          const sideCount = Math.max(0, m.seats - headCount * 2);
          return { table: m, isLeft, isRight, offset: headCount * 2,
                    topCount: Math.ceil(sideCount / 2), botCount: Math.floor(sideCount / 2) };
        }
        return { table: m, isLeft, isRight, offset: 0,
                  topCount: Math.ceil(m.seats / 2), botCount: Math.floor(m.seats / 2) };
      });

      const totalTop = alloc.reduce((s, a) => s + a.topCount, 0);
      const totalBot = alloc.reduce((s, a) => s + a.botCount, 0);
      const topSpacing = (groupWidth - SEAT_RADIUS * 2) / Math.max(totalTop - 1, 1);
      const botSpacing = (groupWidth - SEAT_RADIUS * 2) / Math.max(totalBot - 1, 1);
      const rowStartX  = groupLeft + SEAT_RADIUS;
      const groupMidX  = (groupLeft + groupRight) / 2;

      let topIdx = 0, botIdx = 0;
      for (const a of alloc) {
        const topSeatX = [];
        for (let i = 0; i < a.topCount; i++) {
          const globalX = totalTop === 1 ? groupMidX : rowStartX + topIdx * topSpacing;
          topSeatX.push(globalX - a.table.x);
          topIdx++;
        }
        const botSeatX = [];
        for (let i = 0; i < a.botCount; i++) {
          const globalX = totalBot === 1 ? groupMidX : rowStartX + botIdx * botSpacing;
          botSeatX.push(globalX - a.table.x);
          botIdx++;
        }

        endInfo[a.table.id] = {
          showLeftHead:  headCount > 0 && a.isLeft,
          showRightHead: headCount > 0 && a.isRight,
          topSeatX, botSeatX,
          topOffset: a.offset,
          botOffset: a.offset + a.topCount,
        };
      }
    }

    return endInfo;
  }

  // ── Conjoin detection ─────────────────────────────────────────────────────

  _detectConjoin(movedId) {
    const tables = this.store.tables;
    const moved  = tables.find(t => t.id === movedId);
    if (!moved || moved.type !== 'rect') return;

    const axisAligned = t => {
      const r = ((t.rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      return r < 0.08 || Math.abs(r - Math.PI * 2) < 0.08;
    };
    if (!axisAligned(moved)) return;

    const movedIds = moved.conjoinGroupId
      ? tables.filter(t => t.conjoinGroupId === moved.conjoinGroupId).map(t => t.id)
      : [moved.id];

    for (const srcId of movedIds) {
      const src = tables.find(t => t.id === srcId);
      if (!src) continue;

      const sl = src.x - src.width / 2,  sr = src.x + src.width / 2;
      const st = src.y - src.height / 2, sb = src.y + src.height / 2;

      for (const other of tables) {
        if (movedIds.includes(other.id)) continue;
        if (other.type !== 'rect') continue;
        if (!axisAligned(other)) continue;
        if (src.conjoinGroupId && src.conjoinGroupId === other.conjoinGroupId) continue;

        const ol = other.x - other.width / 2,  or_ = other.x + other.width / 2;
        const ot = other.y - other.height / 2, ob  = other.y + other.height / 2;

        // Only the short ends (left/right caps) can conjoin — never the long sides.
        // Vertical overlap gates whether the two tables are roughly facing each other.
        const vOver = st < ob - 4 && sb > ot + 4;

        let snapDx = 0, snapDy = 0, matched = false;

        if (vOver) {
          if (Math.abs(sr - ol) < CONJOIN_THRESH) { snapDx = ol - sr; snapDy = other.y - src.y; matched = true; }       // right→left
          else if (Math.abs(sl - or_) < CONJOIN_THRESH) { snapDx = or_ - sl; snapDy = other.y - src.y; matched = true; } // left→right
        }

        if (matched) {
          this._snapAndConjoin(movedIds, src.id, other.id, snapDx, snapDy);
          return;
        }
      }
    }
  }

  _snapAndConjoin(movedIds, srcId, otherId, snapDx, snapDy) {
    const tables  = this.store.tables;
    const src     = tables.find(t => t.id === srcId);
    const other   = tables.find(t => t.id === otherId);
    if (!src || !other) return;

    const groupId = src.conjoinGroupId ?? other.conjoinGroupId ?? crypto.randomUUID();

    this.store.mutate(s => {
      const v = s.versions.find(v => v.id === s.currentVersionId);
      // Snap all moved tables by the same delta
      v.tables.forEach(t => {
        if (movedIds.includes(t.id)) { t.x += snapDx; t.y += snapDy; }
      });
      // Merge groups
      const srcGrp   = src.conjoinGroupId;
      const otherGrp = other.conjoinGroupId;
      v.tables.forEach(t => {
        if (movedIds.includes(t.id) || t.id === otherId ||
            (srcGrp   && t.conjoinGroupId === srcGrp)   ||
            (otherGrp && t.conjoinGroupId === otherGrp)) {
          t.conjoinGroupId = groupId;
          // Clear head seats on merge — user can re-enable once grouped
          if (t.headSeats) t.headSeats = 0;
        }
      });
    });

    if (this._selected) this._toolbar._sync();
    this.render();
  }

  // ── Inline table name edit ────────────────────────────────────────────────

  _onDblClick(e) {
    const { x, y } = this._cssPos(e);
    const w = this.toWorld(x, y);
    const hit = this._hitTable(w.x, w.y);
    if (!hit) return;
    this._startInlineEdit(hit);
  }

  _startInlineEdit(table) {
    const existing = document.getElementById('canvas-inline-edit');
    if (existing) existing.remove();

    const s = this.toScreen(table.x, table.y);
    const input = document.createElement('input');
    input.id    = 'canvas-inline-edit';
    input.type  = 'text';
    input.value = table.name ?? '';

    const w = Math.max(80, (table.type === 'circle' ? table.width * 0.9 : table.width * 0.72) * this.zoom);
    input.style.cssText = `
      position: absolute;
      left: ${s.x}px; top: ${s.y}px;
      transform: translate(-50%, -50%);
      width: ${w}px;
      text-align: center;
      font-size: 13px;
      font-weight: 500;
      font-family: 'Avenir Next', Avenir, 'Century Gothic', sans-serif;
      color: #333;
      border: 1.5px solid #2563EB;
      border-radius: 4px;
      padding: 2px 6px;
      outline: none;
      background: rgba(255,255,255,0.96);
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      z-index: 100;
    `;

    const commit = () => {
      const name = input.value;
      const id   = table.id;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        const t = v.tables.find(t => t.id === id);
        if (t) t.name = name;
      });
      input.remove();
      this.render();
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.remove(); this.render(); }
      e.stopPropagation();
    });
    input.addEventListener('blur',      commit);
    input.addEventListener('mousedown', e => e.stopPropagation());

    document.getElementById('canvas-wrap').appendChild(input);
    input.focus();
    input.select();
  }

  // ── Wheel / zoom ──────────────────────────────────────────────────────────

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      const { x, y } = this._cssPos(e);
      const factor = 1 - e.deltaY * 0.01;
      this._applyZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor)), x, y);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.render();
    }
  }

  _applyZoom(nextZoom, cx, cy) {
    const fx = cx ?? this.cssWidth  / 2;
    const fy = cy ?? this.cssHeight / 2;
    this.panX = fx - (fx - this.panX) * (nextZoom / this.zoom);
    this.panY = fy - (fy - this.panY) * (nextZoom / this.zoom);
    this.zoom = nextZoom;
    this._updateZoomLabel();
    this.render();
  }

  _updateZoomLabel() {
    const label = document.getElementById('zoom-label');
    if (label && !label.isContentEditable) {
      label.textContent = `${Math.round(this.zoom * 100)}%`;
    }
  }

  _initZoomLabelEdit() {
    const label = document.getElementById('zoom-label');
    if (!label) return;
    label.addEventListener('dblclick', () => {
      label.contentEditable = 'true';
      label.textContent = `${Math.round(this.zoom * 100)}`;
      label.focus();
      const range = document.createRange();
      range.selectNodeContents(label);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    const commit = () => {
      label.contentEditable = 'false';
      const val = parseInt(label.textContent, 10);
      if (!isNaN(val)) this._applyZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, val / 100)));
      else this._updateZoomLabel();
    };
    label.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
      if (e.key === 'Escape') { label.contentEditable = 'false'; this._updateZoomLabel(); }
      if (!/^[0-9]$/.test(e.key) && !['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Enter','Escape'].includes(e.key))
        e.preventDefault();
    });
    label.addEventListener('blur', commit);
  }

  // ── Drop from table palette ───────────────────────────────────────────────

  _onDrop(e) {
    e.preventDefault();

    const guestId = e.dataTransfer.getData('guestId');
    if (guestId) {
      const { x, y } = this._cssPos(e);
      const w   = this.toWorld(x, y);
      const hit = this._hitTestSeat(w.x, w.y);
      this._assignGuestToSeat(guestId, hit, w);
      this._clearGuestDragHighlight();
      return;
    }

    const type = e.dataTransfer.getData('tableType');
    if (!type) return;
    const { x, y } = this._cssPos(e);
    const w     = this.toWorld(x, y);
    const table = makeTable(type, this.snapToGrid(w.x), this.snapToGrid(w.y));
    this.store.mutate(s => {
      const v = s.versions.find(v => v.id === s.currentVersionId);
      v.tables.push(table);
    });
    this._selected = table.id;
    this._toolbar.show(table.id);
    this.render();
  }

  // ── Guest → seat drag/drop ────────────────────────────────────────────────

  _onDragOver(e) {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('guestid')) {
      this._clearGuestDragHighlight();
      return;
    }
    const { x, y } = this._cssPos(e);
    const w   = this.toWorld(x, y);
    const hit = this._hitTestSeat(w.x, w.y);

    const prev = this._guestDragHoverSeat;
    const same = prev && hit && prev.tableId === hit.tableId && prev.seatIndex === hit.seatIndex;
    if (same || (!prev && !hit)) return;

    this._guestDragHoverSeat = hit;
    this.render();
  }

  _clearGuestDragHighlight() {
    if (!this._guestDragHoverSeat) return;
    this._guestDragHoverSeat = null;
    this.render();
  }

  _onCanvasDragStart(e) {
    if (!this._pendingGuestDrag) { e.preventDefault(); return; }
    const { guestId } = this._pendingGuestDrag;

    e.dataTransfer.setData('guestId', guestId);
    e.dataTransfer.effectAllowed = 'move';

    const guest = this.store.guests.find(g => g.id === guestId);
    if (!guest) return;

    // Same dashed-pill chip regardless of where the drag started (a seat, a floating
    // spot, or the guest list) — one consistent "you're dragging a guest" visual.
    const { canvas, anchorX, anchorY } = buildFloatingGuestDragImage(guest);
    document.body.appendChild(canvas);
    e.dataTransfer.setDragImage(canvas, anchorX, anchorY);
    setTimeout(() => canvas.remove(), 0);
  }

  _onCanvasDragEnd() {
    this.el.draggable = false;
    this._pendingGuestDrag = null;
    this._clearGuestDragHighlight();
  }

  /**
   * Assigns guestId to the seat in `hit` ({ tableId, seatIndex }), or — if `hit` is
   * null (dropped outside any seat) — parks them as a floating marker at `dropPos`
   * instead of sending them back to the guest list, so you can drop guests near a
   * table to work out where they should go before committing to a seat. Swaps with
   * whoever is already in the target seat, if anyone. Scoped to the current version
   * only — versions are independent seating scenarios, so re-seating in one
   * shouldn't touch another.
   */
  _assignGuestToSeat(guestId, hit, dropPos) {
    let fromTableId = null, fromSeatIndex = null;
    outer: for (const t of this.store.tables) {
      for (const [idx, gId] of Object.entries(t.seatAssignments)) {
        if (gId === guestId) { fromTableId = t.id; fromSeatIndex = idx; break outer; }
      }
    }

    if (!hit) {
      if (!dropPos) return;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        if (fromTableId) {
          const t = v.tables.find(t => t.id === fromTableId);
          if (t) delete t.seatAssignments[fromSeatIndex];
        }
        if (!v.floatingGuests) v.floatingGuests = {};
        v.floatingGuests[guestId] = { x: dropPos.x, y: dropPos.y };
      });
      this.render();
      return;
    }

    if (fromTableId === hit.tableId && String(fromSeatIndex) === String(hit.seatIndex)) return; // dropped on their own seat

    // Work out who (if anyone) is about to get displaced, and where they'll end up,
    // before anything changes — so we can animate them traveling there.
    const targetTablePre = this.store.tables.find(t => t.id === hit.tableId);
    const occupantId     = targetTablePre?.seatAssignments[hit.seatIndex];
    const occupantFrom   = occupantId ? this._seatWorldPos(hit.tableId, hit.seatIndex) : null;
    const occupantSeatDest = occupantId && fromTableId ? this._seatWorldPos(fromTableId, fromSeatIndex) : null;

    // The incoming guest wasn't seated anywhere (e.g. dragged from the list), so the
    // displaced occupant has no old seat to swap into — park them just outside the
    // table instead of invisibly sending them back to the guest list.
    let occupantFloatDest = null;
    if (occupantId && !occupantSeatDest && occupantFrom && targetTablePre) {
      const dx = occupantFrom.x - targetTablePre.x, dy = occupantFrom.y - targetTablePre.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const pushOut = 55;
      occupantFloatDest = { x: occupantFrom.x + (dx / dist) * pushOut, y: occupantFrom.y + (dy / dist) * pushOut };
    }
    const occupantDest = occupantSeatDest || occupantFloatDest;

    this.store.mutate(s => {
      const v = s.versions.find(v => v.id === s.currentVersionId);
      const targetTable = v.tables.find(t => t.id === hit.tableId);
      if (!targetTable) return;

      const occupantId = targetTable.seatAssignments[hit.seatIndex];

      if (fromTableId) {
        const src = v.tables.find(t => t.id === fromTableId);
        delete src.seatAssignments[fromSeatIndex];
        if (occupantId && occupantId !== guestId) {
          src.seatAssignments[fromSeatIndex] = occupantId; // swap into guestId's old seat
        }
      } else if (occupantId && occupantId !== guestId && occupantFloatDest) {
        if (!v.floatingGuests) v.floatingGuests = {};
        v.floatingGuests[occupantId] = occupantFloatDest;
      }

      if (v.floatingGuests) delete v.floatingGuests[guestId]; // no longer just parked — they're seated now
      targetTable.seatAssignments[hit.seatIndex] = guestId;
    });

    if (occupantId && occupantId !== guestId && occupantFrom) {
      const seatInfo = occupantSeatDest ? { tableId: fromTableId, seatIndex: fromSeatIndex } : null;
      this._startSeatSwapAnimation(occupantId, occupantFrom, occupantDest, seatInfo);
    }
    this.render();
  }

  /**
   * A displaced guest just fades in at wherever the swap puts them — their new seat,
   * or their new floating spot — rather than visibly traveling there. Subtle nudge
   * toward where they landed, not a flashy animation. The store is already updated
   * by this point; this is purely a visual transition. seatInfo (when landing in a
   * real seat, not a floating spot) tells the ghost to render as a seated guest
   * instead of the floating dashed-pill chip.
   */
  _startSeatSwapAnimation(guestId, from, to, seatInfo = null) {
    const guest = this.store.guests.find(g => g.id === guestId);
    if (!guest) return;

    const dest = to || from;
    const anim = { guestId, guest, x: dest.x, y: dest.y, seatInfo, startTime: performance.now(), duration: 325 };
    this._seatAnimation = anim;

    const step = now => {
      if (this._seatAnimation !== anim) return; // superseded by a newer swap
      const t = Math.min(1, (now - anim.startTime) / anim.duration);
      this.render();
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        this._seatAnimation = null;
        this.render();
      }
    };
    requestAnimationFrame(step);
  }

  _drawSeatSwapGhost(ctx, endInfo) {
    const anim = this._seatAnimation;
    const t = Math.min(1, (performance.now() - anim.startTime) / anim.duration);
    // ease-in-out, so opacity rises gradually the whole way through instead of
    // rushing up in the first instant and then idling — that rush read as a blink.
    const opacity = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    ctx.save();
    ctx.globalAlpha = opacity;
    // Avatar + name together as one unit, so they fade in in sync instead of the
    // avatar appearing first and the name popping in separately once this ends.
    // Landing in a real seat should fade in looking like a seated guest (matching
    // what the render will show once the animation ends) — not the floating
    // dashed-pill chip, which reads as "not seated yet".
    const seatPos = anim.seatInfo && this._seatWorldAngle(anim.seatInfo, endInfo);
    if (seatPos) {
      drawSeat(ctx, anim.x, anim.y, SEAT_RADIUS, anim.guest, seatPos.angle);
    } else {
      drawFloatingGuest(ctx, anim.x, anim.y, anim.guest, false);
    }
    ctx.restore();
  }

  /**
   * The seat's label angle (in world terms) for a given {tableId, seatIndex}, or null
   * if the table/seat no longer exists. getSeatPositions() gives angles relative to
   * the table's own unrotated frame, so a rotated table needs that angle rotated to
   * match — the ghost is drawn in world space, not inside the table's local transform.
   */
  _seatWorldAngle({ tableId, seatIndex }, endInfo) {
    const table = this.store.tables.find(t => t.id === tableId);
    if (!table) return null;
    const positions = getSeatPositions(table, endInfo[tableId]);
    const pos = positions.find(p => String(p.seatIndex) === String(seatIndex));
    return pos ? { angle: pos.angle + table.rotation } : null;
  }

  /**
   * Fires after mousedown+mouseup with no drag in between (native drag suppresses
   * the click event, so this never double-fires alongside a real drag/drop).
   * Handles selecting a floating guest chip and removing one via its "x" badge.
   */
  _onCanvasClick(e) {
    const { x, y } = this._cssPos(e);
    const w = this.toWorld(x, y);

    for (const guestId of this._selectedFloatingGuests) {
      if (this._hitTestFloatingGuestBadge(w.x, w.y, guestId)) {
        this._removeFloatingGuests([guestId]);
        return;
      }
    }

    const guestId = this._hitTestFloatingGuest(w.x, w.y);
    if (guestId) {
      this._selected = null;
      this._toolbar.hide();
      this._selectedFloatingGuests = new Set([guestId]);
      this.render();
    } else if (this._selectedFloatingGuests.size > 0) {
      this._selectedFloatingGuests.clear();
      this.render();
    }
  }

  _removeFloatingGuests(guestIds) {
    this.store.mutate(s => {
      const v = s.versions.find(v => v.id === s.currentVersionId);
      if (!v.floatingGuests) return;
      guestIds.forEach(id => delete v.floatingGuests[id]);
    });
    guestIds.forEach(id => this._selectedFloatingGuests.delete(id));
    this.render();
  }

  _drawSeatHighlight(ctx, endInfo) {
    const { tableId, seatIndex } = this._guestDragHoverSeat;
    const table = this.store.tables.find(t => t.id === tableId);
    if (!table) return;
    const pos = getSeatPositions(table, endInfo[tableId]).find(p => p.seatIndex === seatIndex);
    if (!pos) return;

    const cos = Math.cos(table.rotation), sin = Math.sin(table.rotation);
    const wx = table.x + pos.x * cos - pos.y * sin;
    const wy = table.y + pos.x * sin + pos.y * cos;
    const occupied = !!table.seatAssignments[seatIndex];

    ctx.save();
    ctx.beginPath();
    ctx.arc(wx, wy, SEAT_RADIUS + 4, 0, Math.PI * 2);
    ctx.strokeStyle = occupied ? '#F59E0B' : '#2563EB'; // amber = will swap, blue = empty seat
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  // ── External API ──────────────────────────────────────────────────────────

  addTable(type) {
    const w     = this.toWorld(this.cssWidth / 2, this.cssHeight / 2);
    const table = makeTable(type, this.snapToGrid(w.x), this.snapToGrid(w.y));
    this.store.mutate(s => {
      const v = s.versions.find(v => v.id === s.currentVersionId);
      v.tables.push(table);
    });
    this._selected = table.id;
    this._toolbar.show(table.id);
    this.render();
  }
}
