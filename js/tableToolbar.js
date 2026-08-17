// Floating toolbar that appears above a selected table

export class TableToolbar {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.store  = store;
    this._id    = null;
    this._el    = this._build();
    document.getElementById('canvas-wrap').appendChild(this._el);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  show(tableId) {
    this._id = tableId;
    this._sync();
    this._el.classList.remove('hidden');
  }

  hide() {
    this._id = null;
    this._el.classList.add('hidden');
  }

  // Called from canvas.render() so the toolbar tracks pan/zoom
  updatePosition() {
    if (!this._id) return;
    const table = this._getTable();
    if (!table) return;

    const s    = this.canvas.toScreen(table.x, table.y);
    const halfH = this._halfHeight(table) * this.canvas.zoom;
    const SEAT_R = 12 * this.canvas.zoom;
    const gap    = 14;
    const toolH  = this._el.offsetHeight || 38;

    this._el.style.left      = `${s.x}px`;
    this._el.style.top       = `${s.y - halfH - SEAT_R - gap - toolH}px`;
    this._el.style.transform = 'translateX(-50%)';
  }

  // ── Build DOM ──────────────────────────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.className = 'table-toolbar hidden';
    el.innerHTML = `
      <div    class="tt-seats-wrap">
        <button class="tt-seats-dec">−</button>
        <div class="tt-seats-count">
          <span class="tt-seats-val">8</span>
          <span class="tt-seats-label">seats</span>
        </div>
        <button class="tt-seats-inc">+</button>
      </div>
      <div   class="tt-sep tt-sep-heads" style="display:none"></div>
      <label class="tt-heads-label" style="display:none">
        <input type="checkbox" class="tt-heads-cb" /> Heads
      </label>
      <label class="tt-heads-label tt-heads-double-label" style="display:none">
        <input type="checkbox" class="tt-heads-double-cb" /> &times;2
      </label>
      <div    class="tt-sep tt-sep-ungroup" style="display:none"></div>
      <button class="tt-ungroup"            style="display:none">Ungroup</button>
      <div    class="tt-sep"></div>
      <button class="tt-delete" title="Delete table" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .93h3.8a1 1 0 0 0 1-.93l.6-8.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;

    // Stop canvas mousedown from firing through the toolbar
    el.addEventListener('mousedown', e => e.stopPropagation());

    const get = () => this._getTable();

    // Seats
    el.querySelector('.tt-seats-dec').addEventListener('click', () => {
      const t = get(); if (!t || t.seats <= 1) return;
      this.store.mutate(s => {
        const tbl = this._findTable(s, this._id);
        if (tbl) {
          tbl.seats = Math.max(1, tbl.seats - 1);
          this._rememberDefault(s, tbl.type, { seats: tbl.seats });
        }
      });
      this._sync(); this.canvas.render();
    });
    el.querySelector('.tt-seats-inc').addEventListener('click', () => {
      this.store.mutate(s => {
        const tbl = this._findTable(s, this._id);
        if (tbl) {
          tbl.seats = Math.min(30, tbl.seats + 1);
          this._rememberDefault(s, tbl.type, { seats: tbl.seats });
        }
      });
      this._sync(); this.canvas.render();
    });

    // Head seats checkbox (rect only) — applies to entire group if conjoined.
    // headSeats is a per-end count: 0 (off), 1 (one seat per end), or 2 (two seats
    // side by side per end). The plain checkbox toggles 0 vs 1; the ×2 checkbox
    // (only shown once heads are on) toggles between 1 and 2.
    el.querySelector('.tt-heads-cb').addEventListener('change', e => {
      const id      = this._id;
      const checked = e.target.checked;
      const table   = this._getTable();
      const gid     = table?.conjoinGroupId;
      const headSeats = checked ? 1 : 0;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables.forEach(t => {
          if (t.id === id || (gid && t.conjoinGroupId === gid)) {
            t.headSeats = headSeats;
          }
        });
        this._rememberDefault(s, 'rect', { headSeats });
      });
      this._sync(); this.canvas.render();
    });

    el.querySelector('.tt-heads-double-cb').addEventListener('change', e => {
      const id      = this._id;
      const checked = e.target.checked;
      const table   = this._getTable();
      const gid     = table?.conjoinGroupId;
      const headSeats = checked ? 2 : 1;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables.forEach(t => {
          if (t.id === id || (gid && t.conjoinGroupId === gid)) {
            t.headSeats = headSeats;
          }
        });
        this._rememberDefault(s, 'rect', { headSeats });
      });
      this._sync(); this.canvas.render();
    });

    // Ungroup
    el.querySelector('.tt-ungroup').addEventListener('click', () => {
      const t = get(); if (!t?.conjoinGroupId) return;
      const gid = t.conjoinGroupId;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables.forEach(t => { if (t.conjoinGroupId === gid) t.conjoinGroupId = null; });
      });
      this._sync(); this.canvas.render();
    });

    // Delete
    el.querySelector('.tt-delete').addEventListener('click', () => {
      const id = this._id;
      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables = v.tables.filter(t => t.id !== id);
      });
      this.hide(); this.canvas.render();
    });

    return el;
  }

  // ── Sync UI state to selected table ───────────────────────────────────────

  _sync() {
    const table = this._getTable();
    if (!table) return;

    this._el.querySelector('.tt-seats-val').textContent = this._visibleSeatCount(table);

    const isSweetheart = table.type === 'sweetheart';
    const isRect       = table.type === 'rect';
    const isConjoined  = !!table.conjoinGroupId;

    this._el.querySelector('.tt-seats-wrap').style.display    = isSweetheart ? 'none' : '';

    const showHeads = isRect ? '' : 'none';
    this._el.querySelector('.tt-heads-label').style.display   = showHeads;
    this._el.querySelector('.tt-sep-heads').style.display     = showHeads;
    if (isRect) {
      const headCount = table.headSeats || 0;
      this._el.querySelector('.tt-heads-cb').checked = headCount > 0;
      this._el.querySelector('.tt-heads-double-label').style.display = headCount > 0 ? '' : 'none';
      this._el.querySelector('.tt-heads-double-cb').checked = headCount === 2;
    } else {
      this._el.querySelector('.tt-heads-double-label').style.display = 'none';
    }

    this._el.querySelector('.tt-ungroup').style.display       = isConjoined ? '' : 'none';
    this._el.querySelector('.tt-sep-ungroup').style.display   = isConjoined ? '' : 'none';

    this.updatePosition();
  }

  // ── Rotate ────────────────────────────────────────────────────────────────

  _rotate(delta) {
    const id    = this._id;
    const table = this._getTable();
    if (!table) return;

    if (table.conjoinGroupId) {
      const gid  = table.conjoinGroupId;
      const grp  = this.store.tables.filter(t => t.conjoinGroupId === gid);
      const cx   = grp.reduce((s, t) => s + t.x, 0) / grp.length;
      const cy   = grp.reduce((s, t) => s + t.y, 0) / grp.length;
      const cos  = Math.cos(delta), sin = Math.sin(delta);

      this.store.mutate(s => {
        const v = s.versions.find(v => v.id === s.currentVersionId);
        v.tables.forEach(t => {
          if (t.conjoinGroupId !== gid) return;
          const dx = t.x - cx, dy = t.y - cy;
          t.x = cx + dx * cos - dy * sin;
          t.y = cy + dx * sin + dy * cos;
          t.rotation = (t.rotation + delta + Math.PI * 2) % (Math.PI * 2);
        });
      });
    } else {
      this.store.mutate(s => {
        const t = this._findTable(s, id);
        if (t) t.rotation = (t.rotation + delta + Math.PI * 2) % (Math.PI * 2);
      });
    }
    this._sync();
    this.canvas.render();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _visibleSeatCount(table) {
    let count = table.seats;
    if (!table.headSeats || !table.conjoinGroupId) return count;

    const members = this.store.tables.filter(t => t.conjoinGroupId === table.conjoinGroupId);
    if (members.length < 2) return count;

    // Groups are always horizontal short-end chains — only the group's two end
    // tables can show head seats; interior tables lose both ends' worth.
    const sorted    = [...members].sort((a, b) => a.x - b.x);
    const isLeft    = sorted[0].id === table.id;
    const isRight   = sorted[sorted.length - 1].id === table.id;
    const headCount = Math.min(2, table.headSeats);
    if (!isLeft)  count -= headCount;
    if (!isRight) count -= headCount;

    return Math.max(0, count);
  }

  _getTable()          { return this.store.tables.find(t => t.id === this._id); }
  _halfHeight(table)   { return table.type === 'circle' ? table.width / 2 : table.height / 2; }
  _findTable(s, id)    {
    const v = s.versions.find(v => v.id === s.currentVersionId);
    return v?.tables.find(t => t.id === id);
  }

  /** Remembers a seats/headSeats change as the default for the next new table of this type. */
  _rememberDefault(s, type, patch) {
    s.tableDefaults = s.tableDefaults ?? {};
    s.tableDefaults[type] = { ...(s.tableDefaults[type] ?? {}), ...patch };
  }
}
