# Guest → Seat Drag-and-Drop — Requirements

Status: implemented 2026-07-30. See `js/canvas.js` (`_hitTestSeat`, `_assignGuestToSeat`,
`_onDragOver`/`_onCanvasDragStart`/`_onCanvasDragEnd`, `_drawSeatHighlight`) and
`js/drawTable.js` (`getSeatPositions` — shared by drawing and hit-testing).

Canvas-seat dragging uses the *native* HTML5 drag-and-drop API, not a custom
mouse-tracked drag: `canvas.el.draggable` is toggled to `true` only when a
`mousedown` lands on an occupied seat (checked via `_hitTestSeat`), so the
browser's own `dragstart`/`dragover`/`drop` pipeline handles it — the exact same
pipeline the guest list already used. This means one unified `_onDrop`/`_onDragOver`
code path handles both drag sources; a custom `setDragImage` (a small filled-seat
bubble with the guest's initials) replaces the browser's default whole-canvas
snapshot as the drag preview.

## Why this is the next big piece

`seatAssignments` already exists on every table, seat rendering already reads it to
show initials/name on a filled seat, and guest-list rows already know if they're
seated (checkmark, muted color). The one missing link: nothing writes to
`seatAssignments`. `canvas.js`'s `_onDrop` only handles `tableType` drops (adding a
new table from the bottom toolbar) — a dropped `guestId` is currently ignored
entirely.

## Decisions (confirmed)

1. **Occupied-seat conflict → Swap.** Dragging guest A onto a seat held by guest B
   swaps them: A takes B's seat, B takes A's old seat (or becomes unseated if A
   wasn't seated anywhere yet).
2. **Seated guests are draggable from their seat on canvas, not just from the guest
   list.** Dragging a seated guest to an empty seat moves them; dragging them off
   onto empty canvas (not onto another seat) unseats them.
3. **Live drop-target highlight while dragging.** The specific seat under the
   cursor highlights before drop — one color/style for an empty seat, a different
   one for an occupied seat (since that drop will trigger a swap).

## Core requirements

### 1. Hit-testing: cursor position → seat
- Need a `hitTestSeat(worldX, worldY)` (or similar) that returns `{ tableId, seatIndex }`
  or `null`, checked against every table's actual seat positions.
- **Must reuse the exact same position math `canvas.js`'s `_computeGroupEndInfo()`
  already computes for rendering** (`topSeatX`/`botSeatX`/head-seat positions), not
  a second reimplementation — otherwise the hit target will drift out of alignment
  with what's drawn, especially for conjoined groups where spacing is computed
  across the whole group rather than per-table.
- Circle-table seats, rect-table side seats, rect head seats, and sweetheart seats
  all need covering — each table type currently computes seat positions differently
  in `drawTable.js`.
- Hit threshold: something like `SEAT_RADIUS + a few px` of forgiveness, in world
  units (i.e. divide by `zoom` so the target doesn't get harder to hit when zoomed out).

### 2. Wiring the drop
- `canvas.js`'s `_onDrop` needs a new branch: if `e.dataTransfer.getData('guestId')`
  is present (instead of `tableType`), hit-test the drop point and assign.
- `dragover` on the canvas needs to run the same hit-test continuously (not just at
  drop) to drive the live highlight — store the currently-hovered seat in
  `this._dragHoverSeat` or similar, redraw on change.

### 3. Assignment / swap logic (goes through `store.mutate`, same as everything else, so undo keeps working for free)
- Find and clear the dragged guest's current seat first, wherever it is (search all
  tables' `seatAssignments` for their guest id) — a guest can only occupy one seat.
- If target seat is empty: assign directly.
- If target seat is occupied by a different guest: swap (see decision #1) — the
  occupant goes to the dragged guest's old seat, or becomes unseated if the dragged
  guest didn't have one.
- Dropping onto the seat the guest is already in: no-op.
- Dropping a *seated* guest onto empty canvas (not onto any seat): unseat them
  (clear their `seatAssignments` entry). Dropping an *unseated* guest (dragged from
  the list) onto empty canvas: no-op, same as today.

### 4. Making seated guests draggable from canvas
- Currently only guest-list rows have `draggable=true` + a `dragstart` listener.
  Need the canvas's own mouse handling to support starting a drag from a filled
  seat (`mousedown` on a seat with an assigned guest → recognize as a
  guest-drag rather than a table-drag/table-select).
- This overlaps with existing canvas mouse handling (table select/drag/rotate) —
  needs care so clicking a seat to drag a guest doesn't also trigger table
  selection/move underneath it.

### 5. Visual feedback
- Empty target seat while dragging: some kind of highlight ring, likely accent blue
  to match the "this is where it'll go" affordance used elsewhere (selected-table
  stroke, focus rings).
- Occupied target seat while dragging: a visually distinct highlight (different
  color, maybe amber/orange) signaling "this will swap," so a swap is never a
  surprise.
- No highlight when not hovering any seat.

### 6. Sync
- After any assignment change: canvas re-render (seat shows new guest/empties out),
  side panel re-render (checkmark state, `X/Y guests seated` count, group
  seated-counts) — all of this already happens automatically via `store.subscribe`,
  just needs the mutation itself to land correctly.

## Explicitly out of scope for this pass
- Party/adjacency-aware suggestions (e.g. highlighting other empty seats at a table
  when guests share a `party`) — listed in the original PRD backlog as a separate
  feature.
- Any bulk/auto-seating assistance.

## Open implementation question for whoever picks this up
`_computeGroupEndInfo()` currently only returns rendering-oriented data
(`topSeatX`/`botSeatX` local offsets per table). It may be worth having it (or a
sibling function) also return each seat's **absolute world coordinates** keyed by
`(tableId, seatIndex)`, since both drawing *and* hit-testing need that same
canonical list — would avoid computing it twice in two different shapes.
