// Parse magic entries that share one shape: a heading, Duration: and Range:
// lines, then body prose, set in two columns. Glamours and fairy runes use it.
// Only names the caller gives are kept, so chapter prose can't pass for an
// entry. Pure (no Node APIs) so it runs unchanged in the browser build.

import { reflowColumns } from "../pdf/columns.ts";
import { headingName, headingText, isHeadingShape } from "./heading.ts";

export interface CastEntry {
  name: string;
  duration: string | null;
  range: string | null;
  body: string | null;
}

/** A heading: a short line of words, in any case. pdftotext gives the book's
 *  caps-only headings in mixed case, pdf.js sometimes in random case with wide
 *  gaps (see heading.ts). Returns the line as a heading, or null. */
function asHeading(line: string): string | null {
  const t = headingText(line);
  return isHeadingShape(t, 5, 30) ? t : null;
}

/** True when the first non-blank line after `i` is a Duration: line. Only the
 *  line right under a heading counts, so a short line of prose can't pass. */
function durationFollows(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
    const t = lines[j].trim();
    if (t) return t.startsWith("Duration:");
  }
  return false;
}

/** The next non-blank line after `i`, within three lines. */
function nextLine(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) if (lines[j].trim()) return j;
  return -1;
}

/**
 * The entry heading that starts at line `i`, and the index of its last line.
 * A long name can wrap onto a second line ("Ward Against" / "Rain"); that only
 * counts when the joined name is one of `names`, so a short line of prose above
 * a heading is not taken as part of it.
 */
function headingAt(
  lines: string[],
  i: number,
  names: Set<string>,
): { name: string; last: number } | null {
  const first = asHeading(lines[i]);
  if (!first) return null;
  if (durationFollows(lines, i)) return { name: headingName(first), last: i };
  const j = nextLine(lines, i);
  const second = j > 0 ? asHeading(lines[j]) : null;
  if (!second || !durationFollows(lines, j)) return null;
  const name = headingName(`${first} ${second}`);
  return names.has(name.toLowerCase()) ? { name, last: j } : null;
}

/**
 * Parse the entries named in `names`. Pages are reflowed to one column first.
 * Returns a map of lowercased name → details; the first (full) entry wins.
 */
export function parseCastEntries(pages: string[], names: string[]): Map<string, CastEntry> {
  const entries = new Map<string, CastEntry>();
  const wanted = new Set(names.map((n) => n.toLowerCase()));

  for (const page of pages) {
    const lines = reflowColumns(page).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const head = headingAt(lines, i, wanted);
      if (!head) continue;
      const key = head.name.toLowerCase();
      if (!wanted.has(key) || entries.has(key)) continue;

      let duration: string | null = null;
      let range: string | null = null;
      const body: string[] = [];
      for (let j = head.last + 1; j < lines.length; j++) {
        if (headingAt(lines, j, wanted)) break; // the next entry
        const t = lines[j].trim();
        // Only the lines above the prose: a "Duration: …" paragraph in the
        // prose is part of the text.
        const dm = body.length === 0 && duration === null && t.match(/^Duration:\s*(.+?)\s*$/);
        const rm = body.length === 0 && range === null && t.match(/^Range:\s*(.+?)\s*$/);
        if (dm) duration = dm[1];
        else if (rm) range = rm[1];
        else if (t && !/^\d{1,3}$/.test(t)) body.push(t);
      }

      entries.set(key, {
        name: head.name,
        duration,
        range,
        body: body.length > 0 ? reflowBody(body) : null,
      });
    }
  }
  return entries;
}

/** A body line that begins a new logical line rather than continuing the last.
 *  Mirrors the spell-body heuristic: numbered items and short "Label:" entries
 *  start fresh, everything else flows into the running line. */
function startsBlock(l: string): boolean {
  if (/^\d+\.\s/.test(l)) return true;
  const colon = l.indexOf(":");
  return colon > 0 && colon <= 25 && /^[A-Z][A-Za-z’'-]*(?:\s[A-Za-z’'-]+){0,2}:/.test(l);
}

/** Rejoin hard-wrapped prose into clean logical lines, undoing the PDF's
 *  end-of-line hyphenation. Same shape as the spell-body reflow. */
function reflowBody(raw: string[]): string {
  const out: string[] = [];
  for (const line of raw) {
    const prev = out[out.length - 1] ?? "";
    if (out.length === 0 || startsBlock(line)) {
      out.push(line);
    } else {
      out[out.length - 1] = /[A-Za-z]-$/.test(prev) ? prev.slice(0, -1) + line : `${prev} ${line}`;
    }
  }
  return out.join("\n");
}
