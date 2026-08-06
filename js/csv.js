// Guest-list file parsing (CSV and Excel) and export helpers

import { read, utils } from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

export const TEMPLATE_CSV = `firstName,lastName,party,tags
Jane,Smith,Smith Family,family
John,Smith,Smith Family,family
Alice,Jones,,friends
`;

const REQUIRED_COLUMNS = ['firstname', 'lastname'];

/**
 * Shared row-parsing logic for both CSV and Excel — both boil down to a header row
 * plus an array of data rows, each already split into cells. Keeping this in one
 * place means the validation, duplicate-detection, and guest-shaping rules can't
 * drift between the two formats.
 */
function parseRows(headerCells, dataRows) {
  const headers = headerCells.map(h => String(h ?? '').trim().toLowerCase()
    .replace(/\s+/g, '')
    .replace('first name', 'firstname')
    .replace('last name', 'lastname')
    .replace('party name', 'party')
  );

  const errors = [];
  for (const col of REQUIRED_COLUMNS) {
    if (!headers.includes(col)) {
      errors.push(`Missing required column: "${col}"`);
    }
  }
  if (errors.length) return { guests: [], errors };

  const guests = [];
  const seenNames = new Set();

  dataRows.forEach((cells, i) => {
    if (cells.every(c => String(c ?? '').trim() === '')) return; // blank row

    const row = {};
    headers.forEach((h, idx) => { row[h] = String(cells[idx] ?? '').trim(); });

    const firstName = row.firstname ?? '';
    const lastName  = row.lastname  ?? '';

    if (!firstName && !lastName) return;

    const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
    if (seenNames.has(key)) {
      errors.push(`Duplicate guest on row ${i + 2}: "${firstName} ${lastName}"`);
      return;
    }
    seenNames.add(key);

    const rawTags = (row.tags ?? '').split(';').map(t => t.trim()).filter(Boolean);

    guests.push({
      id: crypto.randomUUID(),
      firstName,
      lastName,
      party: row.party ?? '',
      tags: rawTags,
    });
  });

  if (errors.length) return { guests: [], errors };
  return { guests, errors: [] };
}

export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 1) return { guests: [], errors: ['File is empty.'] };

  const [headerLine, ...dataLines] = lines;
  return parseRows(splitCSVLine(headerLine), dataLines.map(splitCSVLine));
}

/** Reads the first sheet of an Excel workbook (.xlsx or legacy .xls) the same way parseCSV reads a CSV. */
export function parseExcel(arrayBuffer) {
  const workbook = read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  if (!rows.length) return { guests: [], errors: ['File is empty.'] };

  const [headerRow, ...dataRows] = rows;
  return parseRows(headerRow, dataRows);
}

/** Parses a File (from a file input or drop event) as CSV or Excel, based on its extension. */
export async function parseGuestFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseExcel(await file.arrayBuffer());
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return parseCSV(await file.text());
  }
  return { guests: [], errors: [`Unsupported file type: "${file.name}". Please upload a CSV or Excel (.xlsx/.xls) file.`] };
}

/**
 * Matches freshly-parsed guests against the existing guest list by name, so
 * re-uploading a revised CSV doesn't blow away seat assignments for everyone who
 * didn't change. A guest that already exists (same first+last name, case-insensitive)
 * keeps their original id — which is what seat assignments and floating-guest
 * positions are keyed on — while everything else about them (party, tags) updates
 * to whatever the new CSV says. Genuinely new names get a fresh id (already set by
 * parseCSV); names that no longer appear are simply dropped, same as before.
 */
export function reconcileGuests(newGuests, existingGuests) {
  const existingByName = new Map();
  for (const g of existingGuests) {
    existingByName.set(`${g.firstName.toLowerCase()}|${g.lastName.toLowerCase()}`, g);
  }

  return newGuests.map(g => {
    const existing = existingByName.get(`${g.firstName.toLowerCase()}|${g.lastName.toLowerCase()}`);
    return existing ? { ...g, id: existing.id } : g;
  });
}

function splitCSVLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}
