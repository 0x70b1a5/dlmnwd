// Parse the d20 glamours table and the glamour descriptions from the Player's
// Book. The d20 table sits in the enchanter/kindred creation pages; the
// descriptions live in the Fairy Magic chapter (a two-column "Glamours" spread)
// with the same shape as spell entries: a heading, Duration/Range
// lines, then body prose. Pure (no Node APIs) so it runs unchanged in the
// browser build.

import { type CastEntry, parseCastEntries } from "./entries.ts";

export type GlamourEntry = CastEntry;

/**
 * Parse the glamour names out of the d20 table. Empty slots are dropped, so the
 * result is the list of parsed names (not a fixed 20-entry, roll-indexed array);
 * callers only pick from it at random. Returns [] if the table isn't found.
 */
export function parseGlamoursTable(pages: string[]): string[] {
  for (const page of pages) {
    const lines = page.split("\n");
    // The table header has "Glamour" appearing 3 times in a "# Glamour" pattern.
    const headerIdx = lines.findIndex(
      (l) => (l.match(/Glamour/gi) ?? []).length >= 3 && /#/.test(l),
    );
    if (headerIdx < 0) continue;

    const items: string[] = Array.from({ length: 20 }, () => "");
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "") break;

      // Entries: "1   Awe   8   Fairy Dust   15   Seeming"
      // Split on 2+ spaces, then walk pairs of (number, name).
      const parts = line.split(/\s{2,}/);
      for (let j = 0; j < parts.length; j += 1) {
        const m = parts[j].match(/^(\d{1,2})$/);
        if (m && j + 1 < parts.length) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= 20 && items[n - 1] === "") {
            items[n - 1] = parts[j + 1].trim();
            j++; // consume the name
          }
        }
      }
    }
    if (items.filter(Boolean).length >= 10) return items.filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Parse glamour descriptions (entries.ts): only entries named in the glamour
 * table are kept. Returns a map of lowercased name → details. Pass the
 * already-parsed glamour table to avoid re-parsing it.
 */
export function parseGlamourDetails(
  pages: string[],
  glamoursTable?: string[],
): Map<string, GlamourEntry> {
  return parseCastEntries(pages, glamoursTable ?? parseGlamoursTable(pages));
}
