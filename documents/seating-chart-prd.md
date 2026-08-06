# Seating Chart App — PRD (v1)

## Overview
A ground-up rebuild of the seating chart tool. Each chart lives at its own shareable URL, where a user can upload a guest list, build out a floor plan of tables, seat guests, and export the result. Designed for large events (200–300+ guests), desktop-only for v1, with no real-time collaborative sync.

## Goals
- Let a user go from a raw guest spreadsheet to a fully seated floor plan with minimal friction.
- Support iteration through named, duplicable versions rather than a single fixed layout.
- Keep the tool usable at high guest density (200–300+), which shapes several v1 decisions below (zoom/pan, edge-touching conjoin rule, no live sync).

## Out of scope for v1
- Real-time multi-user collaboration
- View-only (non-editing) share links — the one link is edit-access
- Tablet/touch support (may follow in a later version)

---

## 1. Access & Versioning
- Each chart has a unique URL for editing, saving, and sharing (edit access only — no separate view-only link).
- No live sync between simultaneous editors. If a user is viewing a stale version (changes have been saved elsewhere since they loaded), they're notified and given the option to save their current work as a new version, then reload.
- Users can create a new version, duplicate an existing version, and rename versions.
- The guest list is shared across all versions of a chart — only the seating layout (table placement, seating assignments) varies per version.

## 2. Guest Data
- Users upload a spreadsheet of guests, or download a starter template (first name, last name, party name, tags — with built-in tags like groom/bride/family/friends plus support for custom tags).
- On a bad upload (duplicate names, missing required columns), the upload is rejected outright with errors shown, so the user can fix and re-upload rather than getting a partial/silent import.
- Guests populate a left panel once uploaded.
- Side panel supports editing, adding, and deleting guests, and moving them between groups/parties.
- Side panel displays total seat count and current unseated-guest count.
- Export: spreadsheet export in two formats — by table (operational, for the day-of team) and alphabetically (guest-facing, so people can find their own seat).

## 3. Layout & Canvas
- Three-part layout: global nav, main canvas, side panel.
- Canvas: light grey background with a darker grey dot grid; supports zoom and pan (necessary at 200–300+ guest scale).
- Tables are added via three overlay buttons at the bottom of the canvas (circle, rectangle, sweetheart), each showing an image of the shape. On hover, the button grows and gains a drop shadow to signal it's grabbable. Tables can be added by click or by drag.

## 4. Table Management
- Seat count is adjustable per table, except the sweetheart table, which is fixed at 2.
- Tables can be moved, rotated, snapped to the canvas grid, and named.
- Rectangle tables placed with edges exactly touching another rectangle table auto-conjoin into a single group. There's no cap on how many tables can be chained together this way.
- Conjoined groups can be ungrouped.
- Conjoined groups rotate as a single rigid object — not as independently rotating sub-tables.
- Circle tables cannot conjoin with anything.

## 5. Guest Seating
- Guests can be dropped onto a specific seat, or directly onto open canvas — the latter marks them unseated (shown with transparency/lighter styling) so it's visually distinct from a seated guest.
- Guests can be moved between seats freely.
- Party members seat next to each other by default. This adjacency is locked until the user explicitly unlocks it, after which party members can be moved independently.
- If a party is dragged toward a seat but there isn't a matching adjacent seat available, the party drops unseated next to the targeted seat rather than force-splitting across the table.
- Dropping a guest onto an already-occupied seat opens a modal with three options: unseat the currently-seated guest, swap the two guests, or bump all seated guests down the line to the left or right. The bump cascades across the entire conjoined table group (not just the single table), following the seat order of the group.
- Seated guest labels show first name + last initial, angled diagonally, sized/positioned so no two labels ever overlap and each is clearly tied to its seat.

## 6. Other
- Undo is available via keyboard shortcut.

---

## Open technical risks to validate during build
- **Conjoin/ungroup state model.** Treating a conjoined group as one rigid, rotatable object with continuous seat ordering for bump logic is the most structurally complex piece — worth prototyping the data model before broader implementation.
- **Label legibility at max density.** "No overlapping labels, ever" at 200–300+ guests will likely require a collision-avoidance pass on label placement, not just a fixed diagonal angle — flag as a design/engineering collaboration point.
- **Stale-version recovery.** The reload-after-save-as-new-version flow needs a clear UI moment (banner, modal) — worth a quick flow diagram before build.
