// Central state store — persists to localStorage for instant local reads, and
// syncs to Firestore so more than one person can share the same chart.

import { fetchChart, saveChart } from './firebase.js';

const UNDO_LIMIT = 50;

export class Store {
  constructor(chartId) {
    this.chartId = chartId;
    this._listeners = [];
    this._undoStack = [];
    this._remoteReady = false; // don't push to Firestore until we've reconciled with whatever's already there

    const saved = localStorage.getItem(`sc:${chartId}`);
    if (saved) {
      this.state = JSON.parse(saved);
    } else {
      this.state = defaultState(chartId);
      this._persist();
    }

    // Resolves once we've either pulled the latest shared state from Firestore, or
    // (if this chart doesn't exist there yet) seeded it with what we have locally.
    this.ready = this._hydrateFromRemote();
  }

  async _hydrateFromRemote() {
    try {
      const remote = await fetchChart(this.chartId);
      if (remote) {
        this.state = remote;
        this._persist();
        this._emit();
      } else {
        await saveChart(this.chartId, this.state);
      }
    } catch (err) {
      console.error('Firestore sync unavailable — continuing with local data only.', err);
    }
    this._remoteReady = true;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get chartTitle() { return this.state.title; }
  get guests() { return this.state.guests; }
  // User-created group names with no guests in them yet — tag-derived groups (from
  // guests' own `tags`) don't need an entry here, only ones a user explicitly added
  // via "+ Add Group" before anyone was assigned to them.
  get groups() { return this.state.groups ?? []; }
  get currentVersionId() { return this.state.currentVersionId; }

  get currentVersion() {
    return this.state.versions.find(v => v.id === this.state.currentVersionId);
  }

  get versions() { return this.state.versions; }

  get tables() { return this.currentVersion?.tables ?? []; }

  // ── Write (all mutations go through here for undo support) ────────────────

  /**
   * Apply a mutation. fn receives a deep-cloned state and should mutate it in place.
   * pass { silent: true } to skip adding to the undo stack (e.g. viewport changes).
   */
  /**
   * pass { touchVersion: false } for changes that aren't really "editing" the
   * current version's content — e.g. switching which version is active shouldn't
   * bump that version's last-updated timestamp just for being viewed.
   */
  mutate(fn, { silent = false, touchVersion = true } = {}) {
    if (!silent) {
      this._undoStack.push(JSON.stringify(this.state));
      if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    }

    const next = JSON.parse(JSON.stringify(this.state));
    fn(next);

    if (!silent && touchVersion) {
      const v = next.versions.find(v => v.id === next.currentVersionId);
      if (v) v.updatedAt = Date.now();
    }

    this.state = next;
    this._persist();
    this._emit();

    // Silent mutations (e.g. drag-in-progress viewport/position updates) stay local —
    // only push the real, committed changes so we're not writing on every mousemove.
    if (!silent) this._pushRemote();
  }

  undo() {
    const prev = this._undoStack.pop();
    if (!prev) return;
    this.state = JSON.parse(prev);
    this._persist();
    this._emit();
    this._pushRemote();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _persist() {
    localStorage.setItem(`sc:${this.chartId}`, JSON.stringify(this.state));
  }

  _pushRemote() {
    if (!this._remoteReady) return; // avoid clobbering remote data with pre-hydration local state
    saveChart(this.chartId, this.state).catch(err => {
      console.error('Failed to sync change to Firestore — it only saved locally.', err);
    });
  }

  // ── Pub/sub ───────────────────────────────────────────────────────────────

  subscribe(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  _emit() {
    this._listeners.forEach(fn => fn(this.state));
  }

  // ── Stale-version detection ───────────────────────────────────────────────

  /** Returns true if localStorage has a newer savedAt than what we loaded. */
  isStale() {
    const raw = localStorage.getItem(`sc:${this.chartId}`);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    return saved.savedAt > this.state.savedAt;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function newVersion(name = 'Version 1') {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    tables: [],
    floatingGuests: {}, // guestId -> { x, y } — dropped outside a seat, parked on canvas
    createdAt: now,
    updatedAt: now,
  };
}

function defaultState(chartId) {
  const v = newVersion();
  return {
    chartId,
    title: 'Untitled Chart',
    guests: [],
    groups: [],
    versions: [v],
    currentVersionId: v.id,
    savedAt: Date.now(),
  };
}

// ── Convenience mutation helpers (imported where needed) ──────────────────

export function makeTable(type, x, y) {
  const defaults = {
    circle:     { seats: 8,  width: 100, height: 100 },
    rect:       { seats: 8,  width: 180, height: 60  },
    sweetheart: { seats: 2,  width: 110, height: 55  },
  };
  const d = defaults[type];
  return {
    id: crypto.randomUUID(),
    type,
    x,
    y,
    rotation: 0,
    name: 'Table Name',
    seats: d.seats,
    width: d.width,
    height: d.height,
    conjoinGroupId: null,
    headSeats: type === 'rect' ? false : undefined,
    seatAssignments: {},
  };
}
