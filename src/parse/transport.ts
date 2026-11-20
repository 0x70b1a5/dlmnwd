// Parse the animals and vehicles the book sells to carry loads: a table with
// a Cost column and a Load column (animals: what one carries at its normal
// Speed), or a Cost column and a Cargo column (vehicles). The row names, the
// types and the figures all come from the book; nothing is fixed here. Pure (no
// Node APIs), so the browser build runs it too.
//
// The table can share its lines with a neighbouring column of prose. The
// header's first cell that is not a column label (a run of words with a lower-
// case word in it) marks where that neighbour starts, and each row is cut there.

export type TransportKind = "animal" | "vehicle";

export interface Transport {
  name: string;
  kind: TransportKind;
  /** The table's own heading, e.g. "WATER CRAFT". */
  section: string;
  /** The cost cell as printed ("80"; the column says gp). */
  cost?: string;
  /** Coins of weight it carries: an animal at its normal Speed, a vehicle at all. */
  load: number;
  /** The animal's type column ("Pack"), when the table has one. */
  type?: string;
  speed?: number;
  ac?: string;
  hp?: string;
  /** Any other column, by its label ("Crew": "2 rowers"). */
  more?: Record<string, string>;
}

interface Cell {
  text: string;
  x: number;
}

/** A line's cells: runs of text split on two or more spaces. */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) out.push({ text: m[0], x: m.index ?? 0 });
  return out;
}

/** A column label: a capitalised word and perhaps one more ("Pulled by"), and
 *  perhaps a unit in parens. Prose beside the table runs longer. */
const LABEL = /^[A-Z][A-Za-z]*(?: [A-Za-z]+)?(?: \([a-z.]+\))?$/;

interface Header {
  labels: Cell[];
  /** Where the neighbouring text starts, or Infinity. */
  x1: number;
  kind: TransportKind;
}

function header(line: string): Header | null {
  const cs = cells(line);
  const labels: Cell[] = [];
  let x1 = Infinity;
  for (const c of cs) {
    if (LABEL.test(c.text) || c.text === "AC" || c.text === "HP") labels.push(c);
    else {
      x1 = c.x;
      break;
    }
  }
  const names = labels.map((l) => l.text.replace(/\s*\(.*\)$/, ""));
  if (labels.length < 3 || names[1] !== "Cost") return null;
  const kind = names.includes("Load") ? "animal" : names.includes("Cargo") ? "vehicle" : null;
  if (!kind) return null;
  return { labels: labels.map((l, i) => ({ text: names[i], x: l.x })), x1, kind };
}

/** The ALL-CAPS heading a few lines above the header, over its columns. */
function titleAbove(lines: string[], h: number, x1: number): string {
  for (let i = h - 1; i >= Math.max(0, h - 3); i--) {
    const t = lines[i].slice(0, Number.isFinite(x1) ? x1 : undefined).trim();
    if (/^[A-Z][A-Z ,&]+$/.test(t) && t.length > 2) return t;
  }
  return "";
}

/** A whole number as printed ("2,500"); null for anything else ("500 per sq.ft."). */
function count(cell: string | undefined): number | null {
  const t = (cell ?? "").trim();
  return /^\d[\d,]*$/.test(t) ? parseInt(t.replace(/,/g, ""), 10) : null;
}

/** Give each cell after the name the label of its column. */
function byLabel(row: Cell[], labels: Cell[]): Map<string, string> {
  const out = new Map<string, string>();
  const rest = labels.slice(1);
  const values = row.slice(1);
  values.forEach((c, i) => {
    // In order when every column has a cell; else the nearest column by x.
    const label =
      values.length === rest.length
        ? rest[i]
        : rest.reduce((a, b) => (Math.abs(b.x - c.x) < Math.abs(a.x - c.x) ? b : a));
    out.set(label.text, out.has(label.text) ? `${out.get(label.text)} ${c.text}` : c.text);
  });
  return out;
}

const KNOWN = new Set(["Cost", "Load", "Cargo", "Type", "Speed", "AC", "HP"]);

function readTable(lines: string[], from: number, hd: Header, section: string): Transport[] {
  const out: Transport[] = [];
  const x0 = hd.labels[0].x;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].slice(0, Number.isFinite(hd.x1) ? hd.x1 : undefined);
    const row = cells(line);
    if (row.length === 0) {
      // A blank row inside the table (the neighbour's text cut away): go on
      // only if a row follows.
      const next = cells((lines[i + 1] ?? "").slice(0, Number.isFinite(hd.x1) ? hd.x1 : undefined));
      if (next.length > 1 && Math.abs(next[0].x - x0) <= 2) continue;
      break;
    }
    if (Math.abs(row[0].x - x0) > 2 || row.length < 3) break;
    const v = byLabel(row, hd.labels);
    const load = count(v.get(hd.kind === "animal" ? "Load" : "Cargo"));
    if (load === null) continue; // a rate ("per sq.ft.") is no single load
    const t: Transport = { name: row[0].text, kind: hd.kind, section, load };
    const cost = v.get("Cost");
    if (cost && !/^[–—-]$/.test(cost)) t.cost = cost;
    if (v.get("Type")) t.type = v.get("Type");
    const speed = count(v.get("Speed"));
    if (speed !== null) t.speed = speed;
    if (v.get("AC")) t.ac = v.get("AC");
    if (v.get("HP")) t.hp = v.get("HP");
    const more = [...v].filter(([k]) => !KNOWN.has(k));
    if (more.length) t.more = Object.fromEntries(more);
    out.push(t);
  }
  return out;
}

/**
 * An animal's Speed from its numbered stat block ("3. Name", and a stat line
 * with "Speed 50" under it in the same column), when the table gives none.
 */
function statSpeed(pages: string[], name: string): number | undefined {
  const want = name.toLowerCase();
  for (const page of pages) {
    const lines = page.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const c of cells(lines[i])) {
        const m = c.text.match(/^\d+\.\s+(.+)$/);
        if (!m || m[1].toLowerCase() !== want) continue;
        for (let j = i + 1; j < Math.min(lines.length, i + 16); j++) {
          const s = lines[j].slice(Math.max(0, c.x - 2)).match(/\bSpeed (\d+)\b/);
          if (s) return parseInt(s[1], 10);
        }
      }
    }
  }
  return undefined;
}

/** Every animal and vehicle with a load the book lists. The first listing of a name wins. */
export function parseTransport(pages: string[]): Transport[] {
  const seen = new Map<string, Transport>();
  for (const page of pages) {
    if (!/\b(Load|Cargo)\b/.test(page)) continue;
    const lines = page.split("\n");
    lines.forEach((line, i) => {
      const hd = header(line);
      if (!hd) return;
      const section = titleAbove(lines, i, hd.x1);
      for (const t of readTable(lines, i + 1, hd, section)) {
        const key = t.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, t);
      }
    });
  }
  const out = [...seen.values()];
  for (const t of out) {
    if (t.kind === "animal" && t.speed === undefined) {
      const speed = statSpeed(pages, t.name);
      if (speed !== undefined) t.speed = speed;
    }
  }
  return out;
}
