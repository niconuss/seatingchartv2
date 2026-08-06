// Side panel: guest list, upload, stats

import { parseGuestFile, reconcileGuests, TEMPLATE_CSV } from './csv.js';
import { buildFloatingGuestDragImage, getClockwiseSeatOrder } from './drawTable.js';

const CHEVRON_ICON = `
  <svg class="group-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none">
    <path d="M2 1.5L5.5 4L2 6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

const GUEST_TRASH_ICON = `
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .93h3.8a1 1 0 0 0 1-.93l.6-8.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

export class SidePanel {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this._filter = '';
    this._collapsedTags = new Set();
    this._renamingGroup = null; // group name to drop straight into inline-rename mode on next render

    this._bindEvents();
    store.subscribe(() => this.refresh());
    this.refresh();
  }

  refresh() {
    this._renderStats();
    this._renderGuestList();
  }

  _renderStats() {
    const guests = this.store.guests;
    const tables = this.store.tables;

    const seatedIds = new Set(
      tables.flatMap(t => Object.values(t.seatAssignments))
    );
    const seated = guests.filter(g => seatedIds.has(g.id)).length;

    document.getElementById('stat-seated').textContent = `${seated}/${guests.length} guests seated`;
  }

  _renderGuestList() {
    const list = document.getElementById('guest-list');
    const filter = this._filter.toLowerCase();
    const guests = this.store.guests.filter(g => {
      const name = `${g.firstName} ${g.lastName}`.toLowerCase();
      return !filter || name.includes(filter);
    });

    const seatedIds = new Set(
      this.store.tables.flatMap(t => Object.values(t.seatAssignments))
    );

    list.innerHTML = '';

    if (guests.length === 0) {
      const msg = this.store.guests.length === 0 ? 'Upload a CSV to add guests.' : 'No guests match your search.';
      list.innerHTML = `<p class="guest-list-empty">${msg}</p>`;
      this._updateScrollShadows();
      return;
    }

    // Group by each guest's first tag; untagged guests fall into their own group at the end.
    // User-created empty groups (added via "+ Add Group", not yet holding any guest)
    // are folded in too, so they show up in the list ready to be dragged into.
    const groups = new Map();
    for (const tag of this.store.groups) {
      if (!groups.has(tag)) groups.set(tag, []);
    }
    for (const guest of guests) {
      const tag = guest.tags?.[0] || 'Untagged';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(guest);
    }

    // store.groups is the manual order for whichever groups have been explicitly
    // placed (via "+ Add Group" or a reorder drag) — newest-created first. Any tag
    // that only exists because a guest has it (never manually placed) falls back to
    // alphabetical, after all manually-ordered ones. Untagged always sorts last and
    // never joins the manual order.
    const createdOrder = this.store.groups;
    const sortedTags = [...groups.keys()].sort((a, b) => {
      if (a === 'Untagged') return 1;
      if (b === 'Untagged') return -1;
      const aCreated = createdOrder.indexOf(a);
      const bCreated = createdOrder.indexOf(b);
      if (aCreated !== -1 && bCreated !== -1) return aCreated - bCreated;
      if (aCreated !== -1) return -1;
      if (bCreated !== -1) return 1;
      return a.localeCompare(b);
    });
    this._lastSortedTags = sortedTags; // used by _reorderGroups to know current display order

    for (const tag of sortedTags) {
      const members      = groups.get(tag);
      const seatedCount  = members.filter(g => seatedIds.has(g.id)).length;
      const collapsed    = this._collapsedTags.has(tag);

      const section = document.createElement('div');
      section.className = 'guest-group-section';
      section.dataset.groupTag = tag;

      const header = document.createElement('div');
      header.className = `guest-group-label ${collapsed ? 'collapsed' : ''}`;
      header.innerHTML = `
        ${CHEVRON_ICON}
        <span class="guest-group-name">${tag}</span>
        <span class="guest-group-count">${seatedCount}/${members.length} seated</span>
        ${tag !== 'Untagged' ? `<button class="group-delete-btn" title="Delete group" type="button">${GUEST_TRASH_ICON}</button>` : ''}
      `;
      header.addEventListener('click', () => {
        if (collapsed) this._collapsedTags.delete(tag);
        else this._collapsedTags.add(tag);
        this._renderGuestList();
      });

      const nameEl = header.querySelector('.guest-group-name');
      if (tag !== 'Untagged') {
        // The name gets its own click/dblclick handling, separate from the header's
        // collapse toggle — otherwise a double-click to rename would also fire two
        // (self-cancelling but re-render-triggering) collapse toggles first, tearing
        // down the very header the rename is about to target.
        nameEl.addEventListener('click', e => e.stopPropagation());
        nameEl.addEventListener('dblclick', e => {
          e.stopPropagation();
          this._startGroupRename(nameEl, tag);
        });

        header.querySelector('.group-delete-btn').addEventListener('click', e => {
          e.stopPropagation();
          this._deleteGroup(tag);
        });

        // Drag the header itself to reorder groups relative to one another —
        // Untagged is excluded, both as a thing you can drag and as a valid target,
        // since it always has to stay pinned at the bottom.
        header.draggable = true;
        header.addEventListener('dragstart', e => {
          e.dataTransfer.setData('groupTag', tag);
          e.dataTransfer.effectAllowed = 'move';
          e.stopPropagation();
        });
        header.addEventListener('dragend', () => {
          this._reorderIndicator?.remove();
        });
      }

      section.appendChild(header);

      if (!collapsed) {
        for (const guest of members) {
          const seated = seatedIds.has(guest.id);
          const item = document.createElement('div');
          item.className = `guest-item ${seated ? 'seated' : 'unseated'}`;
          item.draggable = true;
          item.dataset.guestId = guest.id;

          item.innerHTML = `
            <span class="guest-name">${guest.firstName} ${guest.lastName}</span>
            <button class="guest-delete-btn" title="Delete guest" type="button">${GUEST_TRASH_ICON}</button>
          `;

          item.addEventListener('dragstart', e => {
            e.dataTransfer.setData('guestId', guest.id);
            e.dataTransfer.effectAllowed = 'move';
            item.classList.add('dragging');

            // Same dashed-pill chip the canvas uses, instead of the browser's default
            // (a screenshot of this row, trash icon and all).
            const { canvas, anchorX, anchorY } = buildFloatingGuestDragImage(guest);
            document.body.appendChild(canvas);
            e.dataTransfer.setDragImage(canvas, anchorX, anchorY);
            setTimeout(() => canvas.remove(), 0);
          });
          item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
          });

          item.querySelector('.guest-delete-btn').addEventListener('click', e => {
            e.stopPropagation();
            this._deleteGuest(guest.id);
          });

          section.appendChild(item);
        }
      }

      // Drop anywhere in the group's section — including on top of other guests
      // already in it, not just the header — to move a dragged guest into it.
      // Dropping on "Untagged" clears their tag rather than setting one.
      //
      // Dropping a dragged *group* header instead reorders groups — Untagged can't
      // be a reorder target, so it always stays pinned at the bottom. Rather than
      // always inserting before whatever section you drop on, an indicator line
      // snaps above or below the hovered section depending on which half of it the
      // cursor is over, so you can precisely place a group before or after any
      // other one (including at the very end).
      section.addEventListener('dragover', e => {
        const types = e.dataTransfer.types;
        if (types.includes('grouptag') && tag !== 'Untagged') {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = section.getBoundingClientRect();
          const indicator = this._getReorderIndicator();
          if (e.clientY < rect.top + rect.height / 2) section.before(indicator);
          else section.after(indicator);
        } else if (types.includes('guestid')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          section.classList.add('drag-over');
        }
      });
      section.addEventListener('dragleave', e => {
        if (!section.contains(e.relatedTarget)) section.classList.remove('drag-over');
      });
      section.addEventListener('drop', e => {
        e.preventDefault();
        section.classList.remove('drag-over');

        const groupTag = e.dataTransfer.getData('groupTag');
        if (groupTag) {
          const insertBeforeTag = this._reorderIndicator?.nextElementSibling?.dataset.groupTag ?? null;
          this._reorderIndicator?.remove();
          this._reorderGroups(groupTag, insertBeforeTag);
          return;
        }

        const guestId = e.dataTransfer.getData('guestId');
        if (!guestId) return;
        this.store.mutate(s => {
          const g = s.guests.find(g => g.id === guestId);
          if (g) g.tags = tag === 'Untagged' ? [] : [tag];
        });
      });

      list.appendChild(section);

      if (tag === this._renamingGroup) {
        this._renamingGroup = null;
        this._startGroupRename(nameEl, tag);
      }
    }

    this._updateScrollShadows();
  }

  /** Shows a shadow at the top/bottom edge of the guest list only while there's actually more content scrolled behind that edge. */
  _updateScrollShadows() {
    const list = document.getElementById('guest-list');
    list.classList.toggle('shadow-top', list.scrollTop > 0);
    list.classList.toggle('shadow-bottom', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }

  /** Inline-renames a group — updates the persisted group name and every member's tag. */
  _startGroupRename(nameEl, tag) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'guest-group-name-input';
    input.value = tag;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const newTag = input.value.trim();
      if (newTag && newTag !== tag) this._renameGroup(tag, newTag);
      else this._renderGuestList();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; this._renderGuestList(); }
    });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('dragover', e => e.stopPropagation());
  }

  _renameGroup(oldTag, newTag) {
    const isDuplicate = newTag.toLowerCase() === 'untagged'
      || this.store.guests.some(g => (g.tags?.[0] ?? '').toLowerCase() === newTag.toLowerCase() && g.tags?.[0] !== oldTag)
      || this.store.groups.some(g => g.toLowerCase() === newTag.toLowerCase() && g !== oldTag);

    if (isDuplicate) { this._renderGuestList(); return; }

    if (this._collapsedTags.has(oldTag)) {
      this._collapsedTags.delete(oldTag);
      this._collapsedTags.add(newTag);
    }

    this.store.mutate(s => {
      s.groups = (s.groups ?? []).map(g => g === oldTag ? newTag : g);
      s.guests.forEach(g => { if (g.tags?.[0] === oldTag) g.tags[0] = newTag; });
    });
  }

  /** Lazily-created, reused insertion-line indicator shown while dragging a group header. */
  _getReorderIndicator() {
    if (!this._reorderIndicator) {
      this._reorderIndicator = document.createElement('div');
      this._reorderIndicator.className = 'group-reorder-indicator';
    }
    return this._reorderIndicator;
  }

  /**
   * Moves draggedTag to sit just before insertBeforeTag (or at the very end of the
   * reorderable groups if insertBeforeTag is null/Untagged). Snapshots the *currently
   * displayed* order of every non-Untagged group — not just the ones already in
   * store.groups — so a tag-derived group (one that only exists because a guest has
   * it, never explicitly created) becomes part of the manual order the first time
   * it's dragged.
   */
  _reorderGroups(draggedTag, insertBeforeTag) {
    if (insertBeforeTag === 'Untagged') insertBeforeTag = null;
    if (draggedTag === insertBeforeTag) return;

    const currentOrder = this._lastSortedTags.filter(t => t !== 'Untagged');
    if (!currentOrder.includes(draggedTag)) return;
    if (insertBeforeTag && !currentOrder.includes(insertBeforeTag)) return;

    const without = currentOrder.filter(t => t !== draggedTag);
    const idx = insertBeforeTag ? without.indexOf(insertBeforeTag) : without.length;
    without.splice(idx, 0, draggedTag);

    this.store.mutate(s => { s.groups = without; });
  }

  /** "+ Add Group" creates the group immediately and drops straight into renaming it in place. */
  _createGroupInline() {
    const existing = new Set([
      'untagged',
      ...this.store.groups.map(g => g.toLowerCase()),
      ...this.store.guests.flatMap(g => g.tags ?? []).map(t => t.toLowerCase()),
    ]);
    let name = 'New Group', n = 2;
    while (existing.has(name.toLowerCase())) name = `New Group ${n++}`;

    this._renamingGroup = name;
    this.store.mutate(s => {
      s.groups = s.groups ?? [];
      s.groups.unshift(name);
    });
  }

  _deleteGuest(guestId) {
    const guest = this.store.guests.find(g => g.id === guestId);
    if (!guest) return;
    if (!confirm(`Delete ${guest.firstName} ${guest.lastName}? This can't be undone.`)) return;

    this.store.mutate(s => {
      s.guests = s.guests.filter(g => g.id !== guestId);
      this._purgeGuestReferences(s, [guestId]);
    });
    this.canvas.render();
  }

  /** Removes a group entirely — its guests fall back to Untagged rather than being deleted. */
  _deleteGroup(tag) {
    const members = this.store.guests.filter(g => (g.tags?.[0] || 'Untagged') === tag);
    if (members.length && !confirm(`Delete group "${tag}"? ${members.length} guest${members.length === 1 ? '' : 's'} will become untagged.`)) return;

    this.store.mutate(s => {
      s.groups = (s.groups ?? []).filter(g => g !== tag);
      s.guests.forEach(g => {
        if (g.tags) g.tags = g.tags.filter(t => t !== tag);
      });
    });
  }

  /** Clears seat assignments and floating-canvas positions for the given guestIds, in every version. */
  _purgeGuestReferences(s, guestIds) {
    const idSet = new Set(guestIds);
    s.versions.forEach(v => {
      v.tables.forEach(t => {
        for (const seatIdx of Object.keys(t.seatAssignments)) {
          if (idSet.has(t.seatAssignments[seatIdx])) delete t.seatAssignments[seatIdx];
        }
      });
      if (v.floatingGuests) {
        for (const guestId of Object.keys(v.floatingGuests)) {
          if (idSet.has(guestId)) delete v.floatingGuests[guestId];
        }
      }
    });
  }

  _bindEvents() {
    // Scroll shadows only appear while there's actually more list scrolled behind
    // that edge — re-checked on scroll and on viewport resize (which can change how
    // much of the list fits without scrolling at all).
    document.getElementById('guest-list').addEventListener('scroll', () => this._updateScrollShadows());
    window.addEventListener('resize', () => this._updateScrollShadows());

    // Search
    document.getElementById('guest-search').addEventListener('input', e => {
      this._filter = e.target.value;
      this._renderGuestList();
    });

    // Search bar is hidden by default — the magnifying glass swaps it in over the
    // "x/x guests seated" heading's exact spot, and its own "x" swaps it back.
    document.getElementById('btn-toggle-search').addEventListener('click', () => {
      document.getElementById('stat-seated').classList.add('hidden');
      document.getElementById('btn-toggle-search').classList.add('hidden');
      document.getElementById('btn-add-guest').classList.add('hidden');
      document.getElementById('guest-search-wrap').classList.remove('hidden');
      document.getElementById('guest-search').focus();
    });
    document.getElementById('btn-search-close').addEventListener('click', () => {
      document.getElementById('guest-search-wrap').classList.add('hidden');
      document.getElementById('stat-seated').classList.remove('hidden');
      document.getElementById('btn-toggle-search').classList.remove('hidden');
      document.getElementById('btn-add-guest').classList.remove('hidden');
      const input = document.getElementById('guest-search');
      input.value = '';
      this._filter = '';
      this._renderGuestList();
    });

    // Import guests
    document.getElementById('btn-import-guests').addEventListener('click', () => {
      this._showImportModal();
    });

    // Add guest
    document.getElementById('btn-add-guest').addEventListener('click', () => {
      this._showAddGuestModal();
    });

    // Add group
    document.getElementById('btn-add-group').addEventListener('click', () => {
      this._createGroupInline();
    });

    // Export dropdown
    const exportBtn  = document.getElementById('btn-export');
    const exportMenu = document.getElementById('export-menu');

    const closeExportMenu = () => {
      exportMenu.classList.add('hidden');
      exportBtn.classList.remove('open');
    };
    this.closeExportMenu = closeExportMenu;

    exportBtn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = exportMenu.classList.contains('hidden');
      window._sc?.versionManager?.closeVersionsMenu?.();
      exportMenu.classList.toggle('hidden', !willOpen);
      exportBtn.classList.toggle('open', willOpen);
    });
    exportMenu.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', closeExportMenu);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeExportMenu(); });

    // Export by table
    document.getElementById('btn-export-table').addEventListener('click', () => {
      const csv = this._buildTableExport();
      downloadText(csv, 'seating-by-table.csv', 'text/csv');
      closeExportMenu();
    });

    // Export alphabetical
    document.getElementById('btn-export-alpha').addEventListener('click', () => {
      const csv = this._buildAlphaExport();
      downloadText(csv, 'seating-alphabetical.csv', 'text/csv');
      closeExportMenu();
    });
  }

  _showImportModal() {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = `
      <h2>Import Guests</h2>
      <div id="import-dropzone" class="import-dropzone">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path d="M11 3v11M11 3l-4.5 4.5M11 3l4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 15.5v2a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <div class="import-dropzone-title">Drag your guest list here</div>
        <div class="import-dropzone-sub">or click to browse — CSV or Excel (.xlsx, .xls)</div>
      </div>
      <input type="file" id="import-file-input" accept=".csv,.txt,.xlsx,.xls" hidden />
      <button id="import-sample-btn" class="import-sample-link" type="button">Download sample CSV</button>
      <div class="modal-actions">
        <button id="import-cancel" type="button">Cancel</button>
      </div>
    `;
    overlay.classList.remove('hidden');

    const dropzone  = document.getElementById('import-dropzone');
    const fileInput = document.getElementById('import-file-input');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) this._importGuestFile(file);
      fileInput.value = '';
    });

    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) this._importGuestFile(file);
    });

    document.getElementById('import-sample-btn').addEventListener('click', () => {
      downloadText(TEMPLATE_CSV, 'guest-list-template.csv', 'text/csv');
    });

    const close = () => overlay.classList.add('hidden');
    document.getElementById('import-cancel').onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };
  }

  async _importGuestFile(file) {
    const result = await parseGuestFile(file);
    if (result.errors.length) {
      this._showUploadErrors(result.errors);
      return;
    }

    // Match against the existing list by name so re-uploading a revised file
    // doesn't orphan seat assignments for everyone who didn't change.
    const reconciled = reconcileGuests(result.guests, this.store.guests);
    const keptIds    = new Set(reconciled.map(g => g.id));
    const removedIds = this.store.guests.filter(g => !keptIds.has(g.id)).map(g => g.id);

    this.store.mutate(s => {
      s.guests = reconciled;
      if (removedIds.length) this._purgeGuestReferences(s, removedIds);
    });
    this.refresh();
    this.canvas.render();
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  _showUploadErrors(errors) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = `
      <h2>Upload failed</h2>
      <p>Fix the following issues and re-upload:</p>
      <ul style="font-size:13px;padding-left:16px;margin-bottom:16px;">
        ${errors.map(e => `<li style="margin-bottom:4px;">${e}</li>`).join('')}
      </ul>
      <div class="modal-actions">
        <button id="err-close" class="primary">OK</button>
      </div>
    `;
    overlay.classList.remove('hidden');
    document.getElementById('err-close').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
  }

  _showAddGuestModal() {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = `
      <h2>Add Guest</h2>
      <div class="form-field">
        <label for="ag-first">First Name</label>
        <input type="text" id="ag-first" class="form-input" autocomplete="off" />
      </div>
      <div class="form-field">
        <label for="ag-last">Last Name</label>
        <input type="text" id="ag-last" class="form-input" autocomplete="off" />
      </div>
      <div class="form-field">
        <label for="ag-party">Party Name <span class="form-optional">(optional)</span></label>
        <input type="text" id="ag-party" class="form-input" autocomplete="off" />
      </div>
      <div class="form-field">
        <label for="ag-tag">Tag <span class="form-optional">(optional)</span></label>
        <input type="text" id="ag-tag" class="form-input" autocomplete="off" />
      </div>
      <div class="modal-actions">
        <button id="ag-cancel" type="button">Cancel</button>
        <button id="ag-save" class="primary" type="button">Add Guest</button>
      </div>
    `;
    overlay.classList.remove('hidden');

    const firstEl = document.getElementById('ag-first');
    const lastEl  = document.getElementById('ag-last');
    const partyEl = document.getElementById('ag-party');
    const tagEl   = document.getElementById('ag-tag');
    firstEl.focus();

    const close = () => overlay.classList.add('hidden');

    const save = () => {
      const firstName = firstEl.value.trim();
      const lastName  = lastEl.value.trim();

      firstEl.classList.toggle('form-input-error', !firstName);
      lastEl.classList.toggle('form-input-error', !lastName);
      if (!firstName || !lastName) return;

      const tag = tagEl.value.trim();
      this.store.mutate(s => {
        s.guests.push({
          id: crypto.randomUUID(),
          firstName,
          lastName,
          party: partyEl.value.trim(),
          tags: tag ? [tag] : [],
        });
      });
      close();
    };

    document.getElementById('ag-cancel').onclick = close;
    document.getElementById('ag-save').onclick = save;
    overlay.onclick = e => { if (e.target === overlay) close(); };
    [firstEl, lastEl, partyEl, tagEl].forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    });
  }

  _buildTableExport() {
    const tables = this.store.tables;
    const guests = this.store.guests;
    const endInfo = this.canvas._computeGroupEndInfo();
    const rows = [['Table', 'Seat', 'First Name', 'Last Name', 'Party']];
    for (const table of tables) {
      const label = table.name || `Table (${table.type})`;
      const order = getClockwiseSeatOrder(table, endInfo[table.id]);
      order.forEach((seatIndex, i) => {
        const gId = table.seatAssignments[seatIndex];
        const g = gId ? guests.find(g => g.id === gId) : null;
        rows.push([label, i + 1, g?.firstName ?? '', g?.lastName ?? '', g?.party ?? '']);
      });
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\n');
  }

  _buildAlphaExport() {
    const tables = this.store.tables;
    const guests = this.store.guests;
    const endInfo = this.canvas._computeGroupEndInfo();

    const seatMap = {};
    for (const table of tables) {
      const label = table.name || `Table (${table.type})`;
      const order = getClockwiseSeatOrder(table, endInfo[table.id]);
      order.forEach((seatIndex, i) => {
        const gId = table.seatAssignments[seatIndex];
        if (gId) seatMap[gId] = { table: label, seat: i + 1 };
      });
    }

    const sorted = [...guests].sort((a, b) =>
      `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`)
    );

    const rows = [['Last Name', 'First Name', 'Party', 'Table', 'Seat']];
    for (const g of sorted) {
      const info = seatMap[g.id];
      rows.push([g.lastName, g.firstName, g.party ?? '', info?.table ?? 'Unseated', info?.seat ?? '']);
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\n');
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
