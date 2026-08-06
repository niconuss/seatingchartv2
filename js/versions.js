// Version management: create, duplicate, rename, switch

const DUPLICATE_ICON = `
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
    <path d="M3.5 10.5V3a1.5 1.5 0 0 1 1.5-1.5h7.5" stroke="currentColor" stroke-width="1.3"/>
  </svg>
`;

const TRASH_ICON = `
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .93h3.8a1 1 0 0 0 1-.93l.6-8.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

function formatUpdatedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Updated ${datePart}, ${timePart}`;
}

export class VersionManager {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this._renamingId = null;

    this._bindEvents();
    store.subscribe(() => this._renderVersionList());
    this._renderVersionList();
  }

  _renderVersionList() {
    const list = document.getElementById('version-list');
    const current = this.store.currentVersionId;

    const currentVersion = this.store.versions.find(v => v.id === current);
    document.getElementById('current-version-label').textContent = currentVersion?.name ?? 'Version';

    list.innerHTML = '';
    const sorted = [...this.store.versions].sort((a, b) => b.createdAt - a.createdAt);
    for (const v of sorted) {
      const item = document.createElement('div');
      item.className = `version-item ${v.id === current ? 'active' : ''}`;
      item.dataset.versionId = v.id;

      const canDelete = this.store.versions.length > 1;
      item.innerHTML = `
        <div class="version-info">
          <span class="version-name" title="Double-click to rename">${v.name}</span>
          <span class="version-updated">${formatUpdatedAt(v.updatedAt)}</span>
        </div>
        <button class="version-duplicate-btn" title="Duplicate version" type="button">${DUPLICATE_ICON}</button>
        ${canDelete ? `<button class="version-delete-btn" title="Delete version" type="button">${TRASH_ICON}</button>` : ''}
      `;

      const switchIfNotCurrent = () => { if (v.id !== current) this.switchTo(v.id); };
      item.querySelector('.version-name').addEventListener('click', switchIfNotCurrent);

      item.querySelector('.version-name').addEventListener('dblclick', e => {
        e.stopPropagation();
        this._startInlineRename(item, v);
      });

      item.querySelector('.version-duplicate-btn').addEventListener('click', e => {
        e.stopPropagation();
        this.duplicate(v.id);
      });

      item.querySelector('.version-delete-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        this.delete(v.id);
      });

      list.appendChild(item);

      if (v.id === this._renamingId) {
        this._renamingId = null;
        this._startInlineRename(item, v, { selectAll: true });
      }
    }
  }

  _startInlineRename(item, version) {
    const nameEl = item.querySelector('.version-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'version-name-input';
    input.value = version.name;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name && name !== version.name) {
        this.store.mutate(s => {
          const v = s.versions.find(v => v.id === version.id);
          if (v) v.name = name;
        });
      } else {
        this._renderVersionList();
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; this._renderVersionList(); }
    });
    input.addEventListener('click', e => e.stopPropagation());
  }

  _bindEvents() {
    document.getElementById('btn-new-version').addEventListener('click', () => {
      this.createNew();
    });

    // Versions popover
    const versionsBtn  = document.getElementById('btn-versions');
    const versionsMenu = document.getElementById('version-menu');

    const closeVersionsMenu = () => {
      versionsMenu.classList.add('hidden');
      versionsBtn.classList.remove('open');
    };
    this.closeVersionsMenu = closeVersionsMenu;

    versionsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = versionsMenu.classList.contains('hidden');
      window._sc?.sidePanel?.closeExportMenu?.();
      versionsMenu.classList.toggle('hidden', !willOpen);
      versionsBtn.classList.toggle('open', willOpen);
    });
    versionsMenu.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', closeVersionsMenu);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVersionsMenu(); });
  }

  switchTo(versionId) {
    this.store.mutate(s => { s.currentVersionId = versionId; }, { touchVersion: false });
    this.canvas.render();
    this.closeVersionsMenu?.();
  }

  createNew() {
    const id = crypto.randomUUID();
    this._renamingId = id;
    this.store.mutate(s => {
      s.versions.push({ id, name: `Version ${s.versions.length + 1}`, tables: [], createdAt: Date.now() });
      s.currentVersionId = id;
    });
    this.canvas.render();
  }

  duplicate(versionId) {
    const src = this.store.versions.find(v => v.id === versionId);
    if (!src) return;
    const id = crypto.randomUUID();
    this._renamingId = id;
    this.store.mutate(s => {
      const source = s.versions.find(v => v.id === versionId);
      const clone = JSON.parse(JSON.stringify(source));
      clone.id = id;
      clone.name = `${source.name} copy`;
      clone.createdAt = Date.now();
      // Give all tables new IDs to avoid reference collisions
      clone.tables = clone.tables.map(t => ({ ...t, id: crypto.randomUUID() }));
      s.versions.push(clone);
      s.currentVersionId = id;
    });
    this.canvas.render();
  }

  delete(versionId) {
    if (this.store.versions.length <= 1) return;
    const v = this.store.versions.find(v => v.id === versionId);
    if (!v) return;
    if (!confirm(`Delete "${v.name}"? This can't be undone.`)) return;

    this.store.mutate(s => {
      s.versions = s.versions.filter(ver => ver.id !== versionId);
      if (s.currentVersionId === versionId) {
        s.currentVersionId = s.versions[0].id;
      }
    }, { touchVersion: false });
    this.canvas.render();
  }
}
