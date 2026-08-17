// Pure canvas drawing functions for tables and seats

export const SEAT_RADIUS = 12;

const TABLE_COLOR          = '#ffffff';
const TABLE_STROKE         = '#cccccc';
const TABLE_SELECTED_STROKE = '#2563EB';
const SEAT_COLOR           = '#e8e8e8';
const SEAT_STROKE          = '#bbbbbb';
const SEAT_FILLED_COLOR    = '#2563EB';
const SEAT_FILLED_STROKE   = '#1D4ED8';
const FLOATING_AVATAR_COLOR  = '#6C93F5'; // lighter blue — not actually seated, just parked here
const FLOATING_AVATAR_STROKE = '#4A6FE0';
const NAME_LABEL_COLOR     = '#555';
const SEATED_NAME_COLOR    = '#111'; // near-black — darker than a floating guest's name, this one's actually seated
const HANDLE_COLOR         = '#2563EB';
const GROUP_LINE_COLOR     = '#999999';
const ROTATE_HANDLE_STEM   = SEAT_RADIUS + 14;  // gap from outermost seat to handle
const ROTATE_HANDLE_R      = 9;                 // handle circle radius (world units)

// ── Public helpers ────────────────────────────────────────────────────────────

export function tableHalfHeight(table) {
  return table.type === 'circle' ? table.width / 2 : table.height / 2;
}

/** Returns the world-space position of the rotate handle for a given table. */
export function getRotateHandleWorld(table) {
  const dist = tableHalfHeight(table) + ROTATE_HANDLE_STEM + ROTATE_HANDLE_R;
  // Handle sits straight DOWN in table-local space (0, +dist) to stay below the toolbar.
  return {
    x: table.x - dist * Math.sin(table.rotation),
    y: table.y + dist * Math.cos(table.rotation),
  };
}

// ── Group highlight (drawn in world space, before tables) ─────────────────────

export function drawGroupHighlight(ctx, members) {
  if (members.length < 2) return;

  // All group members share the same rotation — compute bounding box in group-local space
  const rotation = members[0].rotation;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const cx = members.reduce((s, t) => s + t.x, 0) / members.length;
  const cy = members.reduce((s, t) => s + t.y, 0) / members.length;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of members) {
    const dx = t.x - cx, dy = t.y - cy;
    // Un-rotate to group-local frame
    const lx =  dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const hw = t.width / 2, hh = t.height / 2;
    minX = Math.min(minX, lx - hw);
    maxX = Math.max(maxX, lx + hw);
    minY = Math.min(minY, ly - hh);
    maxY = Math.max(maxY, ly + hh);
  }

  const pad = 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.beginPath();
  ctx.roundRect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2, 8);
  ctx.strokeStyle = GROUP_LINE_COLOR;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * endInfo: { showLeftHead, showRightHead, topSeatX, botSeatX, topOffset, botOffset } —
 * computed by canvas._computeGroupEndInfo() so seat spacing is uniform across a whole
 * conjoined group, not just within one table. Undefined for non-rect tables.
 */
export function drawTable(ctx, table, guests, selected, endInfo) {
  ctx.save();
  ctx.translate(table.x, table.y);
  ctx.rotate(table.rotation);

  if      (table.type === 'circle')     drawCircleTable(ctx, table, guests, selected);
  else if (table.type === 'rect')       drawRectTable(ctx, table, guests, selected, endInfo);
  else if (table.type === 'sweetheart') drawSweetheartTable(ctx, table, guests, selected);

  if (selected) drawRotateHandle(ctx, table);

  ctx.restore();
}

// ── Rotate handle (drawn in table-local space) ────────────────────────────────

function drawRotateHandle(ctx, table) {
  const halfH   = tableHalfHeight(table);
  const stemBot = halfH + SEAT_RADIUS + 4;            // bottom of seat ring
  const handleY = halfH + ROTATE_HANDLE_STEM + ROTATE_HANDLE_R;  // positive = below

  // Dashed stem
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, stemBot);
  ctx.lineTo(0, handleY - ROTATE_HANDLE_R);
  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth   = 1.3;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Handle circle
  ctx.beginPath();
  ctx.arc(0, handleY, ROTATE_HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle   = '#fff';
  ctx.fill();
  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth   = 1.9;
  ctx.stroke();

  // ↻ arrow inside handle
  ctx.save();
  ctx.translate(0, handleY);  // positive handleY = below table
  ctx.beginPath();
  ctx.arc(0, 0, ROTATE_HANDLE_R * 0.52, -Math.PI * 0.75, Math.PI * 0.5);
  ctx.strokeStyle = HANDLE_COLOR;
  ctx.lineWidth   = 1.9;
  ctx.stroke();
  // Arrow tip
  const tipX = ROTATE_HANDLE_R * 0.52 * Math.cos(Math.PI * 0.5);
  const tipY = ROTATE_HANDLE_R * 0.52 * Math.sin(Math.PI * 0.5);
  ctx.beginPath();
  ctx.moveTo(tipX - 3.2, tipY - 1.3);
  ctx.lineTo(tipX + 1.3, tipY - 4.5);
  ctx.lineTo(tipX + 2.6, tipY + 1.9);
  ctx.closePath();
  ctx.fillStyle = HANDLE_COLOR;
  ctx.fill();
  ctx.restore();
}

/**
 * Standalone tables (no conjoinGroupId) show the same weight/color stroke as the
 * group highlight, drawn directly on the table's own edge. Once conjoined, members
 * revert to the plain light stroke and the darker stroke instead outlines the whole
 * group (see drawGroupHighlight). Selection always wins and shows the accent stroke.
 */
function tableStroke(table, selected) {
  if (selected) return [TABLE_SELECTED_STROKE, 2];
  if (table.conjoinGroupId) return [TABLE_STROKE, 1];
  return [GROUP_LINE_COLOR, 1.5];
}

/**
 * Returns [{ seatIndex, x, y, angle }] in table-local coordinates (pre-rotation,
 * pre-translation) — angle is the outward-facing direction used for the name label.
 * This is the single source of truth for seat placement, used both for drawing and
 * for hit-testing a drag-drop onto a seat (see canvas.js `_hitTestSeat`), so the two
 * can never drift out of alignment.
 */
export function getSeatPositions(table, endInfo) {
  if (table.type === 'circle') {
    const r = table.width / 2;
    const seatR = r + SEAT_RADIUS + 4;
    const positions = [];
    for (let i = 0; i < table.seats; i++) {
      const angle = (2 * Math.PI * i) / table.seats - Math.PI / 2;
      positions.push({ seatIndex: i, x: Math.cos(angle) * seatR, y: Math.sin(angle) * seatR, angle });
    }
    return positions;
  }

  if (table.type === 'sweetheart') {
    const hw = table.width / 2, hh = table.height / 2;
    const seatY = -(hh + SEAT_RADIUS + 4);
    const angle = -Math.PI / 2;
    return [
      { seatIndex: 0, x: -hw / 2, y: seatY, angle },
      { seatIndex: 1, x:  hw / 2, y: seatY, angle },
    ];
  }

  // rect
  const hw = table.width / 2, hh = table.height / 2;
  const positions = [];

  if (table.headSeats) {
    // headSeats is a per-end count (1 or 2) — 2 seats at an end sit side by side
    // along the table's short axis rather than stacked outward.
    const side  = hw + SEAT_RADIUS + 4;
    const count = Math.min(2, table.headSeats);
    const yOffsets = count === 2 ? [-(SEAT_RADIUS + 3), SEAT_RADIUS + 3] : [0];

    if (endInfo?.showLeftHead ?? true) {
      yOffsets.forEach((y, i) => positions.push({ seatIndex: i, x: -side, y, angle: Math.PI }));
    }
    if (endInfo?.showRightHead ?? true) {
      yOffsets.forEach((y, i) => positions.push({ seatIndex: count + i, x: side, y, angle: 0 }));
    }
  }

  const topY = -(hh + SEAT_RADIUS + 4);
  const botY =  (hh + SEAT_RADIUS + 4);
  const topOffset = endInfo?.topOffset ?? 0;
  const botOffset = endInfo?.botOffset ?? 0;

  (endInfo?.topSeatX ?? []).forEach((x, i) => {
    positions.push({ seatIndex: topOffset + i, x, y: topY, angle: -Math.PI / 2 });
  });
  (endInfo?.botSeatX ?? []).forEach((x, i) => {
    positions.push({ seatIndex: botOffset + i, x, y: botY, angle: Math.PI / 2 });
  });

  return positions;
}

/**
 * Seat indexes in clockwise physical order around the table, for exports where a
 * "Seat" number should let someone walk the table and place cards in sequence.
 * Circle/sweetheart tables already enumerate seats clockwise from the top by
 * construction (their seatIndex order matches getSeatPositions()'s order 1:1), so
 * those are returned as-is. Rect tables enumerate top-row-then-bottom-row (both
 * left-to-right), which jumps backward across the table rather than walking its
 * perimeter, so those get re-sorted starting from the left edge — sorting by each
 * seat's actual (x, y) angle around the table center, not the fixed label-facing
 * angle getSeatPositions() also returns (which is the same for every seat in a row
 * and useless for telling seats in that row apart).
 */
export function getClockwiseSeatOrder(table, endInfo) {
  const positions = getSeatPositions(table, endInfo);
  if (table.type !== 'rect') return positions.map(p => p.seatIndex);

  const startAngle = Math.PI; // left edge
  const key = p => {
    const angle = Math.atan2(p.y, p.x);
    return ((angle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  };
  return [...positions].sort((a, b) => key(a) - key(b)).map(p => p.seatIndex);
}

// ── Circle table ──────────────────────────────────────────────────────────────

function drawCircleTable(ctx, table, guests, selected) {
  const r = table.width / 2;

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle   = TABLE_COLOR;
  ctx.fill();
  [ctx.strokeStyle, ctx.lineWidth] = tableStroke(table, selected);
  ctx.stroke();

  drawTableName(ctx, table.name);
  drawSeatsFromPositions(ctx, table, guests, getSeatPositions(table));
}

// ── Rectangle table ───────────────────────────────────────────────────────────

function drawRectTable(ctx, table, guests, selected, endInfo) {
  const hw = table.width / 2, hh = table.height / 2;

  ctx.beginPath();
  ctx.roundRect(-hw, -hh, table.width, table.height, 6);
  ctx.fillStyle   = TABLE_COLOR;
  ctx.fill();
  [ctx.strokeStyle, ctx.lineWidth] = tableStroke(table, selected);
  ctx.stroke();

  // A conjoined group's name is drawn separately, in its own pass after every
  // table is painted (see drawRectGroupName / canvas.js render()) — not here.
  // Drawing it inline with whichever member happens to "own" it would risk a
  // later-painted group member's opaque fill covering it right back up, since
  // the name's world position can land on a different table's territory (e.g.
  // the middle table of a 3-table group).
  drawSeatsFromPositions(ctx, table, guests, getSeatPositions(table, endInfo));
}

/**
 * Draws a rect table's (or conjoined group's) name — called in its own pass after
 * every table has been painted, so a later-drawn group member's fill can never
 * paint over it. Must be called with the same translate/rotate transform drawTable
 * uses for this table (i.e. from within the same per-table ctx.save()/restore()).
 */
export function drawRectGroupName(ctx, table, endInfo) {
  if (!(endInfo?.showName ?? true)) return;
  ctx.save();
  ctx.translate(endInfo?.nameOffsetX ?? 0, 0);
  drawTableName(ctx, table.name);
  ctx.restore();
}

// ── Sweetheart table ──────────────────────────────────────────────────────────

function drawSweetheartTable(ctx, table, guests, selected) {
  const hw = table.width / 2, hh = table.height / 2;
  const cr = hh * 0.51; // matches the original 18/35 ratio, scales with table size

  ctx.beginPath();
  ctx.moveTo(-hw + cr, -hh);
  ctx.quadraticCurveTo(-hw, -hh, -hw, -hh + cr);
  ctx.lineTo(-hw, hh - cr);
  ctx.quadraticCurveTo(-hw, hh, -hw + cr, hh);
  ctx.lineTo(hw - cr, hh);
  ctx.quadraticCurveTo(hw, hh, hw, hh - cr);
  ctx.lineTo(hw, -hh + cr);
  ctx.quadraticCurveTo(hw, -hh, hw - cr, -hh);
  ctx.closePath();
  ctx.fillStyle   = TABLE_COLOR;
  ctx.fill();
  [ctx.strokeStyle, ctx.lineWidth] = tableStroke(table, selected);
  ctx.stroke();

  drawTableName(ctx, table.name);
  drawSeatsFromPositions(ctx, table, guests, getSeatPositions(table));
}

function drawSeatsFromPositions(ctx, table, guests, positions) {
  for (const pos of positions) {
    const guestId = table.seatAssignments[pos.seatIndex];
    const guest   = guestId ? guests.find(g => g.id === guestId) : null;
    drawSeat(ctx, pos.x, pos.y, SEAT_RADIUS, guest, pos.angle);
  }
}

// ── Seat ──────────────────────────────────────────────────────────────────────

export function drawSeat(ctx, x, y, r, guest, labelAngle) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle   = guest ? SEAT_FILLED_COLOR : SEAT_COLOR;
  ctx.fill();
  ctx.strokeStyle = guest ? SEAT_FILLED_STROKE : SEAT_STROKE;
  ctx.lineWidth   = 1;
  ctx.stroke();

  if (guest) {
    ctx.fillStyle = '#fff';
    ctx.font      = `bold ${Math.floor(r * 0.75)}px 'Avenir Next', Avenir, 'Century Gothic', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(getInitials(guest), x, y);
    drawNameLabel(ctx, x, y, r, guest, labelAngle);
  }
}

/**
 * Just two possible label angles, mirror images of each other (±45°), rather than
 * one unique angle per seat direction — keeps every table's labels reading as one
 * consistent diagonal style instead of the full fan of angles a round table's 8
 * seats would otherwise produce. Right-half seats slant up-right; left-half seats
 * slant up-left (via right-alignment, so the text still ends right next to the seat).
 *
 * Seats that face straight down (bottom row of a rect table, a circle table's
 * bottom seat) get the same -45° rotation as right-half/"upper" seats — not the
 * mirrored +45° — so the whole table reads at one consistent angle. They stay
 * right-aligned though, so the label approaches from below-left and ends at the
 * seat, rather than starting right at the seat and climbing back over it.
 */
function drawNameLabel(ctx, sx, sy, r, guest, angle) {
  const lx = sx + Math.cos(angle) * (r + 10);
  const ly = sy + Math.sin(angle) * (r + 10);

  const cos = Math.cos(angle), sin = Math.sin(angle);
  const facingStraightDown = Math.abs(cos) < 0.15 && sin > 0;
  const rightHalf = cos >= 0;

  const rotation = (facingStraightDown || rightHalf) ? -Math.PI / 4 : Math.PI / 4;
  const align    = (facingStraightDown || !rightHalf) ? 'right' : 'left';

  ctx.save();
  ctx.translate(lx, ly);
  ctx.rotate(rotation);
  ctx.textAlign    = align;
  ctx.textBaseline = 'middle';
  ctx.font         = "bold 10px 'Avenir Next', Avenir, 'Century Gothic', sans-serif";
  ctx.fillStyle    = SEATED_NAME_COLOR;
  ctx.fillText(`${guest.firstName} ${guest.lastName[0]}.`, 0, 0);
  ctx.restore();
}

// ── Floating guest (dropped on empty canvas — not seated, just parked here) ────

const FLOATING_GAP  = 6;
const FLOATING_PADX = 8;
const FLOATING_PADY = 5;
const FLOATING_FONT = "10px 'Avenir Next', Avenir, 'Century Gothic', sans-serif";
const REMOVE_BADGE_R = 7;

/**
 * The pill's bounding box in world coords — the single source of truth for both
 * drawing the pill and hit-testing clicks/drags/marquee-selection against it, so a
 * click anywhere on the chip (not just the avatar) registers.
 */
export function getFloatingGuestBounds(ctx, x, y, guest) {
  const label = `${guest.firstName} ${guest.lastName[0]}.`;
  ctx.save();
  ctx.font = FLOATING_FONT;
  const textWidth = ctx.measureText(label).width;
  ctx.restore();

  const left   = x - SEAT_RADIUS - FLOATING_PADX;
  const right  = x + SEAT_RADIUS + FLOATING_GAP + textWidth + FLOATING_PADX;
  const top    = y - SEAT_RADIUS - FLOATING_PADY;
  const bottom = y + SEAT_RADIUS + FLOATING_PADY;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** World-space center of a selected chip's remove ("x") badge, top-right of the pill. */
export function getFloatingGuestBadgeCenter(ctx, x, y, guest) {
  const b = getFloatingGuestBounds(ctx, x, y, guest);
  return { x: b.right, y: b.top };
}

/**
 * A dashed pill around an avatar + name, sitting wherever the user dropped a guest
 * outside any seat. Visually distinct from a real seat: dotted outline instead of a
 * solid one, straight (non-diagonal) text since it's a self-contained chip, not a
 * label radiating off a seat. When selected, the outline turns accent blue and a
 * small "x" badge appears at the top-right corner to remove it from the canvas.
 */
export function drawFloatingGuest(ctx, x, y, guest, selected = false) {
  const label  = `${guest.firstName} ${guest.lastName[0]}.`;
  const bounds = getFloatingGuestBounds(ctx, x, y, guest);

  ctx.save();

  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.width, bounds.height, bounds.height / 2);
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = selected ? TABLE_SELECTED_STROKE : GROUP_LINE_COLOR;
  ctx.lineWidth   = selected ? 2 : 1.3;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(x, y, SEAT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle   = FLOATING_AVATAR_COLOR;
  ctx.fill();
  ctx.strokeStyle = FLOATING_AVATAR_STROKE;
  ctx.lineWidth   = 1;
  ctx.stroke();

  ctx.fillStyle    = '#fff';
  ctx.font         = `bold ${Math.floor(SEAT_RADIUS * 0.75)}px 'Avenir Next', Avenir, 'Century Gothic', sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(getInitials(guest), x, y);

  ctx.fillStyle    = NAME_LABEL_COLOR;
  ctx.font         = FLOATING_FONT;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + SEAT_RADIUS + FLOATING_GAP, y);

  if (selected) {
    const bx = bounds.right, by = bounds.top;
    ctx.beginPath();
    ctx.arc(bx, by, REMOVE_BADGE_R, 0, Math.PI * 2);
    ctx.fillStyle   = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#c00';
    ctx.lineWidth   = 1.3;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bx - 2.5, by - 2.5); ctx.lineTo(bx + 2.5, by + 2.5);
    ctx.moveTo(bx + 2.5, by - 2.5); ctx.lineTo(bx - 2.5, by + 2.5);
    ctx.strokeStyle = '#c00';
    ctx.lineWidth   = 1.4;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Builds a small offscreen canvas rendering a guest as the same dashed-pill chip
 * used everywhere else, for use as a native drag image — so a guest being dragged
 * looks identical whether the drag started on the canvas or in the guest list.
 * Returns { canvas, anchorX, anchorY } — anchorX/Y is where to anchor the cursor
 * (the avatar's center) when passing this to dataTransfer.setDragImage().
 */
export function buildFloatingGuestDragImage(guest) {
  const measureCtx = document.createElement('canvas').getContext('2d');
  const b = getFloatingGuestBounds(measureCtx, 0, 0, guest);
  const pad = 4;
  const w = b.width + pad * 2, h = b.height + pad * 2;
  const dpr = window.devicePixelRatio || 1;

  const canvas = document.createElement('canvas');
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.cssText = `position:absolute; top:-1000px; left:-1000px; width:${w}px; height:${h}px;`;

  const originX = pad - b.left;
  const originY = pad - b.top;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(originX, originY);
  drawFloatingGuest(ctx, 0, 0, guest, false);

  return { canvas, anchorX: originX, anchorY: originY };
}

// ── Shared ────────────────────────────────────────────────────────────────────

function drawTableName(ctx, name) {
  if (!name) return;
  ctx.fillStyle    = '#333';
  ctx.font         = "500 13px 'Avenir Next', Avenir, 'Century Gothic', sans-serif"; // medium — another step down
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 0, 0);
}

function getInitials(guest) {
  return (((guest.firstName ?? '')[0] ?? '') + ((guest.lastName ?? '')[0] ?? '')).toUpperCase();
}
