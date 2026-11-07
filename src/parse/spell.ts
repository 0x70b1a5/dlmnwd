import { reflowColumns } from "../pdf/columns.ts";
import type { Spell } from "../schema.ts";
import { headingText, headingName, isHeadingShape } from "./heading.ts";

const RANK_HEADER = /Rank\s+(\d+)\s+(Arcane|Holy)\s+Spells/i;

// A trailing flavour story box follows each Holy spell; its text is excluded.
const FLAVOR_STORY = /^\s*The miracle of\b/i;
// A bare folio number or a running-header fragment left in a column by the reflow.
const isFurniture = (line: string) => /^\d{1,3}$/.test(line.trim()) || line.includes("|");

// A spell name is a short all-caps line (letters, spaces, apostrophes, hyphens,
// and the slash in dual spells like "IGNITE / EXTINGUISH").
function capsHeader(line: string): string | null {
  const t = line.trim();
  if (t.length < 3 || t.length > 40) return null;
  if (!/^[A-Z][A-Z '’/-]+$/.test(t)) return null;
  if (/^(PART|RANK)\b/.test(t)) return null;
  return t;
}

// A name in a caps-only font stored in mixed or random case (see heading.ts).
function mixedHeader(line: string): string | null {
  const t = headingText(line);
  return isHeadingShape(t, 6, 40) && !/^(part|rank)\b/i.test(t) ? t : null;
}

// The first non-blank line after a mixed-case name must open the entry. A caps
// name can wrap, and only needs a `Duration:` line within a few lines.
const ENTRY_START = /^\s*(Duration|Prayer name):/;
function nextLine(lines: string[], j: number): string {
  while (j < lines.length && !lines[j].trim()) j++;
  return lines[j] ?? "";
}

/** A header is a spell entry only if a `Duration:` line follows within a few lines. */
function isSpellHeader(lines: string[], i: number): string | null {
  return spellHeaderAt(lines, i)?.name ?? null;
}

/**
 * If line i starts a spell entry, return its Title-Case name and the line where
 * the body begins. A caps name can wrap onto a second line before the Duration
 * line; the fragments merge into one name (not a bodiless phantom).
 */
function spellHeaderAt(lines: string[], i: number): { name: string; bodyStart: number } | null {
  // A mixed-case name is one line, and the entry opens on the next line.
  const mixed = mixedHeader(lines[i]);
  if (!capsHeader(lines[i])) {
    if (!mixed || !ENTRY_START.test(nextLine(lines, i + 1))) return null;
    return { name: headingName(mixed), bodyStart: i + 1 };
  }
  const parts: string[] = [];
  let j = i;
  while (j < lines.length && capsHeader(lines[j]) && !/Duration:/.test(lines[j])) {
    parts.push(capsHeader(lines[j]) as string);
    j++;
  }
  if (!/Duration:/.test(lines.slice(j, j + 4).join("\n"))) return null;
  return { name: headingName(parts.join(" ")), bodyStart: j };
}

/**
 * The heading of a page that opens a section: a short title, then a one-line
 * tagline sentence, at the top of the page (below the running header).
 */
function sectionOpener(page: string): string | null {
  const top = page
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("|"))
    .slice(0, 2);
  if (top.length < 2) return null;
  const [title, tagline] = top;
  if (title.length > 40 || /\s{2,}/.test(title) || /[.:]$/.test(title)) return null;
  if (tagline.length < 20 || /\s{2,}/.test(tagline) || !tagline.endsWith(".")) return null;
  return title;
}

/**
 * Parse every spell entry out of the extracted pages. Rank and tradition are
 * carried from the most recent "Rank N <Arcane|Holy> Spells" heading. This is
 * the build-time transform; queries hit the database, not this.
 */
export function parseSpells(pages: string[]): Spell[] {
  const spells: Spell[] = [];
  let rank: number | undefined;
  let tradition: Spell["tradition"];

  // Other sections (e.g. glamours) use the same entry layout. A section that
  // doesn't open with a rank heading stops the run until the next rank heading.
  let inSpells = true;

  for (let p = 0; p < pages.length; p++) {
    const opener = sectionOpener(pages[p]);
    if (opener && !RANK_HEADER.test(opener)) {
      inSpells = false;
      rank = undefined;
      tradition = undefined;
    }
    const lines = reflowColumns(pages[p]).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const rh = lines[i].match(RANK_HEADER);
      if (rh) {
        rank = parseInt(rh[1], 10);
        tradition = rh[2] as Spell["tradition"];
        inSpells = true;
        continue;
      }
      if (!inSpells) continue;
      const hdr = spellHeaderAt(lines, i);
      if (hdr) {
        spells.push(collect(lines, hdr.bodyStart, hdr.name, rank, tradition, p + 1));
        i = hdr.bodyStart - 1; // skip the (possibly wrapped) name lines
      }
    }
  }
  return spells;
}

function collect(
  lines: string[],
  bodyStart: number,
  name: string,
  rank: number | undefined,
  tradition: Spell["tradition"],
  page: number,
): Spell {
  const body: string[] = [];
  let prayerName: string | undefined;
  let duration: string | undefined;
  let range: string | undefined;

  for (let j = bodyStart; j < lines.length; j++) {
    if (RANK_HEADER.test(lines[j]) || isSpellHeader(lines, j) || FLAVOR_STORY.test(lines[j])) break;
    const pm = lines[j].match(/^\s*Prayer name:\s*(.+?)\s*$/);
    const dm = lines[j].match(/^\s*Duration:\s*(.+?)\s*$/);
    const rm = lines[j].match(/^\s*Range:\s*(.+?)\s*$/);
    if (pm) {
      prayerName = pm[1];
    } else if (dm) {
      duration = dm[1];
    } else if (rm) {
      range = rm[1];
    } else if (!isFurniture(lines[j])) {
      body.push(lines[j]);
    }
  }

  return {
    name,
    tradition,
    rank,
    prayerName,
    duration,
    range,
    body: reflowBody(body),
    source: { book: "players", page },
  };
}

/** A body line that begins a new logical line rather than continuing the last. */
function startsBlock(l: string): boolean {
  if (/^\d+\.\s/.test(l)) return true; // "1." numbered list item
  if (/^(Tiny|Small|Medium|Large|Huge|Gargantuan)\b.*—.*—/.test(l)) return true; // stat-block type line
  if (/^(Level \d+ AC \d+|Att |Saves )/.test(l)) return true; // stat-block stat line
  const colon = l.indexOf(":");
  return colon > 0 && colon <= 25 && /^[A-Z][A-Za-z’'-]*(?:\s[A-Za-z’'-]+){0,2}:/.test(l); // "Label:"
}

/**
 * Rejoin a spell body into clean logical lines. The PDF hard-wraps prose (with
 * end-of-line hyphenation) and the column reflow injects stray blank lines
 * mid-paragraph; both are undone here. A new logical line starts only at real
 * structure (list item, "Label:" entry, embedded stat block) or a blank line
 * that follows a completed sentence — so a blank splitting a sentence is healed.
 */
function reflowBody(raw: string[]): string {
  const out: string[] = [];
  let sawBlank = true; // treat the start as if it followed a break
  for (const r of raw) {
    const line = r.trim();
    if (!line) {
      sawBlank = true;
      continue;
    }
    const prev = out[out.length - 1] ?? "";
    const breakHere =
      out.length === 0 || startsBlock(line) || (sawBlank && /[.!?:]["’”]?$/.test(prev));
    sawBlank = false;
    if (breakHere) {
      out.push(line);
    } else {
      // De-hyphenate a soft word-break; otherwise join with a space.
      out[out.length - 1] = /[A-Za-z]-$/.test(prev) ? prev.slice(0, -1) + line : `${prev} ${line}`;
    }
  }
  return out.join("\n");
}
