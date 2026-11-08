// A port of the text layout that `pdftotext -layout` uses (poppler's
// TextOutputDev.cc: TextPage::addChar, TextPage::coalesce, TextBlock::coalesce,
// TextLine::coalesce and the physical-layout branch of TextPage::dump).
//
// The parsers read pdftotext's fixed-width text, so the browser build must
// produce the same text from pdf.js. pdftotext does not place text by its x
// position: it groups words into blocks and lines, and gives each block a start
// column by counting characters in the blocks to its left. Copying that rule,
// not measuring glyphs, is what makes the two paths agree.
//
// Only horizontal, left-to-right text (rotation 0) is handled. Pure: no Node
// APIs, so it runs unchanged in the browser.

/** A run of glyphs drawn by one text operation, in device space (y grows down). */
export interface GlyphRun {
  str: string;
  x: number; // left edge of the first glyph
  base: number; // baseline y
  width: number; // advance width of the whole run
  fontSize: number;
  font: string;
  ascent: number; // above the baseline, as a fraction of the font size
  descent: number; // below the baseline (negative), as a fraction of the font size
}

// Poppler's constants, with their names.
const textPoolStep = 4;
const minWordBreakSpace = 0.1;
const minDupBreakOverlap = 0.2;
const maxLineSpacingDelta = 1.5;
const maxBlockFontSizeDelta1 = 0.05;
const maxBlockFontSizeDelta2 = 0.6;
const maxBlockFontSizeDelta3 = 0.2;
const maxWordFontSizeDelta = 0.05;
const maxIntraLineDelta = 0.5;
const maxWordSpacing = 1.5;
const minColSpacing1 = 0.7;
const minColSpacing2 = 1.0;
const minCharSpacing = -0.5;
const maxCharSpacing = 0.03;
const maxWideCharSpacingMul = 1.3;
const maxWideCharSpacing = 0.4;
const dupMaxPriDelta = 0.1;
const dupMaxSecDelta = 0.2;

interface Char {
  c: string;
  edge: number; // left edge
  pos: number; // index in the content stream, to tell adjoining words apart
  font: string;
}

interface Word {
  chars: Char[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  base: number;
  fontSize: number;
  edgeEnd: number;
  posEnd: number;
  spaceAfter: boolean;
}

interface Line {
  words: Word[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  base: number;
  fontSize: number; // the first word's
  text: string[];
  edge: number[];
  col: number[];
}

interface Block {
  pool: Pool;
  lines: Line[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  col: number;
  nColumns: number;
}

/**
 * Words bucketed by baseline, as poppler's TextPool. Each bucket stays sorted
 * by xMin as words arrive; a cursor at the last insert decides where a word
 * with an equal xMin goes (poppler 24.02, the pdftotext this matches).
 */
class Pool {
  private buckets = new Map<number, Word[]>();
  private cursor: { word: Word; idx: number } | null = null;
  min = 0;
  max = -1;

  idx(base: number): number {
    const i = base / textPoolStep;
    if (Number.isNaN(i) || i < this.min) return this.min;
    if (i > this.max) return this.max;
    return Math.trunc(i);
  }

  get(i: number): Word[] {
    let b = this.buckets.get(i);
    if (!b) {
      b = [];
      this.buckets.set(i, b);
    }
    return b;
  }

  add(w: Word): void {
    const i = Math.trunc(w.base / textPoolStep);
    if (this.max < this.min) {
      this.min = i - 128;
      this.max = i + 128;
    } else if (i < this.min) {
      this.min = i - 128;
    } else if (i > this.max) {
      this.max = i + 128;
    }
    const bucket = this.get(i);
    let k = 0;
    if (this.cursor && this.cursor.idx === i && w.xMin >= this.cursor.word.xMin) {
      k = bucket.indexOf(this.cursor.word) + 1;
    }
    while (k < bucket.length && w.xMin > bucket[k].xMin) k++;
    bucket.splice(k, 0, w);
    this.cursor = { word: w, idx: i };
  }
}

// UnicodeIsWhitespace (poppler/UTF.cc).
const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
 * Split glyph runs into words, as TextPage::addChar. Each run is one addChar
 * call: one glyph, or the text of an /ActualText span. Only a run of a single
 * whitespace character breaks a word; a longer run keeps its spaces.
 */
function buildWords(runs: GlyphRun[]): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  let lastCharOverlap = false;
  let pos = 0;
  const endWord = () => {
    if (cur && cur.chars.length) words.push(cur);
    cur = null;
  };

  for (const r of runs) {
    const chars = [...r.str];
    if (chars.length === 0) continue;
    if (chars.length === 1 && WHITESPACE.has(chars[0].codePointAt(0) as number)) {
      pos++;
      endWord();
      continue;
    }
    if (chars.length === 1 && chars[0] === "\0") {
      pos++;
      continue;
    }
    const w = r.width / chars.length;
    for (let i = 0; i < chars.length; i++, pos++) {
      const x = r.x + i * w;
      if (cur) {
        const fs = cur.fontSize;
        const sp = x - cur.xMax;
        const delta = x - cur.chars[cur.chars.length - 1].edge;
        const overlap =
          Math.abs(delta) < dupMaxPriDelta * fs &&
          Math.abs(r.base - cur.base) < dupMaxSecDelta * fs;
        if (
          overlap ||
          lastCharOverlap ||
          sp < -minDupBreakOverlap * fs ||
          sp > minWordBreakSpace * fs ||
          Math.abs(r.base - cur.base) > 0.5 ||
          r.fontSize !== fs
        )
          endWord();
        lastCharOverlap = overlap;
      } else {
        lastCharOverlap = false;
      }
      if (!cur) {
        let yMin = r.base - r.ascent * r.fontSize;
        let yMax = r.base - r.descent * r.fontSize;
        if (yMin === yMax) {
          yMin = r.base;
          yMax = r.base + 1;
        }
        cur = {
          chars: [],
          xMin: x,
          xMax: x,
          yMin,
          yMax,
          base: r.base,
          fontSize: r.fontSize,
          edgeEnd: x,
          posEnd: pos,
          spaceAfter: false,
        };
      }
      const word: Word = cur;
      word.chars.push({ c: chars[i], edge: x, pos, font: r.font });
      word.xMax = word.edgeEnd = x + w;
      word.posEnd = pos + 1;
    }
  }
  endWord();
  return words;
}

function newBlock(): Block {
  return { pool: new Pool(), lines: [], xMin: 0, xMax: -1, yMin: 0, yMax: -1, col: 0, nColumns: 0 };
}

function addToBlock(blk: Block, w: Word): void {
  blk.pool.add(w);
  if (blk.xMin > blk.xMax) {
    blk.xMin = w.xMin;
    blk.xMax = w.xMax;
    blk.yMin = w.yMin;
    blk.yMax = w.yMax;
  } else {
    blk.xMin = Math.min(blk.xMin, w.xMin);
    blk.xMax = Math.max(blk.xMax, w.xMax);
    blk.yMin = Math.min(blk.yMin, w.yMin);
    blk.yMax = Math.max(blk.yMax, w.yMax);
  }
}

/** Move every word in buckets [from, to] that passes `test` into the block. */
function takeAll(
  pool: Pool,
  blk: Block,
  from: () => number,
  to: () => number,
  step: 1 | -1,
  test: (w: Word) => boolean,
  onTake: (w: Word) => void = () => {},
): boolean {
  let found = false;
  for (let b = from(); step > 0 ? b <= to() : b >= to(); b += step) {
    const bucket = pool.get(b);
    for (let i = 0; i < bucket.length; ) {
      const w = bucket[i];
      if (test(w)) {
        bucket.splice(i, 1);
        addToBlock(blk, w);
        onTake(w);
        found = true;
      } else {
        i++;
      }
    }
  }
  return found;
}

/** Group the page's words into blocks, as the block loop of TextPage::coalesce. */
function buildBlocks(pool: Pool): Block[] {
  const blocks: Block[] = [];
  let poolMin = pool.min;
  for (;;) {
    while (poolMin <= pool.max && pool.get(poolMin).length === 0) poolMin++;
    if (poolMin > pool.max) break;

    // The left-most word in the first four lines (avoids starting on a superscript).
    let start = poolMin;
    for (let b = poolMin + 1; b < poolMin + 4 && b <= pool.max; b++) {
      if (pool.get(b).length && pool.get(b)[0].xMin < pool.get(start)[0].xMin) start = b;
    }
    const blk = newBlock();
    const first = pool.get(start).shift() as Word;
    addToBlock(blk, first);

    const fs = first.fontSize;
    let minBase = first.base;
    let maxBase = first.base;
    const colSpace1 = minColSpacing1 * fs;
    const colSpace2 = minColSpacing2 * fs;
    const lineSpace = maxLineSpacingDelta * fs;
    const intra = maxIntraLineDelta * fs;
    const sameSize = (w: Word, d: number) => Math.abs(w.fontSize - fs) < d * fs;
    const onLines = (w: Word) => w.base >= minBase - intra && w.base <= maxBase + intra;
    const lineRange = [() => pool.idx(minBase - intra), () => pool.idx(maxBase + intra)] as const;

    let found: boolean;
    do {
      // Lines above, then below, the block.
      let newMin = minBase;
      found = takeAll(
        pool,
        blk,
        () => pool.idx(minBase),
        () => pool.idx(minBase - lineSpace),
        -1,
        (w) =>
          w.base < minBase &&
          w.base >= minBase - lineSpace &&
          w.xMin < blk.xMax &&
          w.xMax > blk.xMin &&
          sameSize(w, maxBlockFontSizeDelta1),
        (w) => (newMin = w.base),
      );
      minBase = newMin;

      let newMax = maxBase;
      found =
        takeAll(
          pool,
          blk,
          () => pool.idx(maxBase),
          () => pool.idx(maxBase + lineSpace),
          1,
          (w) =>
            w.base > maxBase &&
            w.base <= maxBase + lineSpace &&
            w.xMin < blk.xMax &&
            w.xMax > blk.xMin &&
            sameSize(w, maxBlockFontSizeDelta1),
          (w) => (newMax = w.base),
        ) || found;
      maxBase = newMax;

      // Words on the block's lines that overlap it horizontally.
      found =
        takeAll(
          pool,
          blk,
          ...lineRange,
          1,
          (w) =>
            onLines(w) &&
            w.xMin < blk.xMax + colSpace1 &&
            w.xMax > blk.xMin - colSpace1 &&
            sameSize(w, maxBlockFontSizeDelta2),
        ) || found;
      if (found) continue;

      // Up to three outlying words just left, then just right, of the block.
      const near = [
        (w: Word) => w.xMax <= blk.xMin && w.xMax > blk.xMin - colSpace2,
        (w: Word) => w.xMin >= blk.xMax && w.xMin < blk.xMax + colSpace2,
      ];
      for (const side of near) {
        const test = (w: Word) => onLines(w) && side(w) && sameSize(w, maxBlockFontSizeDelta3);
        let n = 0;
        for (let b = lineRange[0](); b <= lineRange[1](); b++) if (pool.get(b).some(test)) n++;
        if (n === 0 || n > 3) continue;
        for (let b = lineRange[0](); b <= lineRange[1](); b++) {
          const bucket = pool.get(b);
          const i = bucket.findIndex(test);
          if (i < 0) continue;
          const [w] = bucket.splice(i, 1);
          addToBlock(blk, w);
          if (w.base < minBase) minBase = w.base;
          else if (w.base > maxBase) maxBase = w.base;
          found = true;
        }
      }
    } while (found);

    coalesceBlock(blk);
    blocks.push(blk);
  }
  return blocks;
}

/** Drop a word drawn twice at the same place (fake bold, drop shadows). */
function dropDuplicates(pool: Pool): void {
  for (let i0 = pool.min; i0 <= pool.max; i0++) {
    const b0 = pool.get(i0);
    for (let j = 0; j < b0.length; j++) {
      const w0 = b0[j];
      const pri = dupMaxPriDelta * w0.fontSize;
      const sec = dupMaxSecDelta * w0.fontSize;
      const text = w0.chars.map((c) => c.c).join("");
      for (let i1 = i0; i1 <= pool.idx(w0.base + sec); i1++) {
        const b1 = pool.get(i1);
        for (let k = i1 === i0 ? j + 1 : 0; k < b1.length; k++) {
          const w1 = b1[k];
          if (
            w1.chars.length === w0.chars.length &&
            w1.chars.map((c) => c.c).join("") === text &&
            Math.abs(w0.xMin - w1.xMin) < pri &&
            Math.abs(w0.xMax - w1.xMax) < pri &&
            Math.abs(w0.yMin - w1.yMin) < sec &&
            Math.abs(w0.yMax - w1.yMax) < sec
          ) {
            b1.splice(k, 1);
            k--;
          }
        }
      }
    }
  }
}

/** Build the block's lines and their columns, as TextBlock::coalesce. */
function coalesceBlock(blk: Block): void {
  const pool = blk.pool;
  dropDuplicates(pool);

  let poolMin = pool.min;
  let cur = -1; // the line inserted last
  for (;;) {
    while (poolMin <= pool.max && pool.get(poolMin).length === 0) poolMin++;
    if (poolMin > pool.max) break;
    let start = poolMin;
    for (let b = poolMin + 1; b < poolMin + 4 && b <= pool.max; b++) {
      if (pool.get(b).length && pool.get(b)[0].xMin < pool.get(start)[0].xMin) start = b;
    }
    const first = pool.get(start).shift() as Word;
    const words = [first];
    let last = first;
    const fs = first.fontSize;
    const minBase = first.base - maxIntraLineDelta * fs;
    const maxBase = first.base + maxIntraLineDelta * fs;
    const wordSpacing = maxWordSpacing * fs;

    // Add the left-most word on this baseline that is near the last one.
    for (;;) {
      let best: { bucket: Word[]; i: number } | null = null;
      let overlap = false;
      for (let b = pool.idx(minBase); !overlap && b <= pool.idx(maxBase); b++) {
        const bucket = pool.get(b);
        const i = bucket.findIndex((w) => w.base >= minBase && w.base <= maxBase);
        if (i < 0) continue;
        const w = bucket[i];
        const delta = w.xMin - last.xMax;
        if (delta < minCharSpacing * fs) overlap = true;
        else if (delta < wordSpacing && (!best || w.xMin < best.bucket[best.i].xMin))
          best = { bucket, i };
      }
      if (overlap || !best) break;
      const [w] = best.bucket.splice(best.i, 1);
      words.push(w);
      last = w;
    }

    const line: Line = {
      words,
      xMin: Math.min(...words.map((w) => w.xMin)),
      xMax: Math.max(...words.map((w) => w.xMax)),
      yMin: Math.min(...words.map((w) => w.yMin)),
      yMax: Math.max(...words.map((w) => w.yMax)),
      base: first.base,
      fontSize: fs,
      text: [],
      edge: [],
      col: [],
    };
    coalesceLine(line);
    // Insert in (baseline, xMin) order. A line that ties goes before the
    // lines it ties with, as poppler's list insert does.
    let k = cur >= 0 && cmpYX(line, blk.lines[cur]) > 0 ? cur + 1 : 0;
    while (k < blk.lines.length && cmpYX(line, blk.lines[k]) > 0) k++;
    blk.lines.splice(k, 0, line);
    cur = k;
  }

  // Columns within the block: a line starts after the text of the lines to its
  // left, counted in characters.
  const byX = blk.lines.toSorted((a, b) => a.xMin - b.xMin || a.base - b.base);
  blk.nColumns = 0;
  for (let i = 0; i < byX.length; i++) {
    const l0 = byX[i];
    let col1 = 0;
    for (let j = 0; j < i; j++) {
      const l1 = byX[j];
      let col2: number;
      if (l0.xMin - l1.xMax >= 0) {
        col2 = l1.col[l1.text.length] + 1;
      } else {
        let k = 0;
        while (k < l1.text.length && l0.xMin >= 0.5 * (l1.edge[k] + l1.edge[k + 1])) k++;
        col2 = l1.col[k];
      }
      col1 = Math.max(col1, col2);
    }
    for (let k = 0; k < l0.col.length; k++) l0.col[k] += col1;
    blk.nColumns = Math.max(blk.nColumns, l0.col[l0.text.length]);
  }
}

/** Order lines by baseline, then left edge (TextLine::cmpYX). */
const cmpYX = (a: Line, b: Line): number =>
  Math.sign(a.base - b.base) || Math.sign(a.xMin - b.xMin);

/** The gap between two words on a line. */
const gap = (a: Word, b: Word): number => b.xMin - a.xMax;

/** Merge touching words and mark word spaces, as TextLine::coalesce. */
function coalesceLine(line: Line): void {
  const ws = line.words;
  if (ws.length > 1) {
    let minSpace = 0;
    if (ws[0].chars.length === 1 && ws[1].chars.length === 1) {
      minSpace = gap(ws[0], ws[1]);
      for (let i = 1; i + 1 < ws.length && minSpace > 0; i++) {
        if (ws[i + 1].chars.length > 1) minSpace = 0;
        minSpace = Math.min(minSpace, gap(ws[i], ws[i + 1]));
      }
    }
    const space =
      minSpace <= 0
        ? maxCharSpacing * ws[0].fontSize
        : Math.min(maxWideCharSpacingMul * minSpace, maxWideCharSpacing * ws[0].fontSize);

    for (let i = 0; i + 1 < ws.length; ) {
      const w0 = ws[i];
      const w1 = ws[i + 1];
      if (gap(w0, w1) >= space) {
        w0.spaceAfter = true;
        i++;
      } else if (
        w0.chars[w0.chars.length - 1].font === w1.chars[0].font &&
        Math.abs(w0.fontSize - w1.fontSize) < maxWordFontSizeDelta * ws[0].fontSize &&
        w1.chars[0].pos === w0.posEnd
      ) {
        w0.xMin = Math.min(w0.xMin, w1.xMin);
        w0.yMin = Math.min(w0.yMin, w1.yMin);
        w0.xMax = Math.max(w0.xMax, w1.xMax);
        w0.yMax = Math.max(w0.yMax, w1.yMax);
        w0.chars.push(...w1.chars);
        w0.edgeEnd = w1.edgeEnd;
        w0.posEnd = w1.posEnd;
        ws.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }

  for (const w of ws) {
    for (const c of w.chars) {
      line.text.push(c.c);
      line.edge.push(c.edge);
    }
    line.edge.push(w.edgeEnd);
    if (w.spaceAfter) line.text.push(" ");
    else if (w !== ws[ws.length - 1]) line.edge.pop(); // the next word's first edge replaces it
  }
  line.col = line.text.map((_, i) => i);
  line.col.push(line.text.length);
}

/** Give each block a start column, as the column loop of TextPage::coalesce. */
function assignBlockColumns(blocks: Block[]): Block[] {
  const sorted = blocks.toSorted((a, b) => a.xMin - b.xMin || a.yMin - b.yMin);
  for (let i = 0; i < sorted.length; i++) {
    const b0 = sorted[i];
    let col1 = 0;
    for (let j = 0; j < i; j++) {
      const b1 = sorted[j];
      let col2: number;
      if (b0.xMin > b1.xMax) col2 = b1.col + b1.nColumns + 3;
      else if (b1.xMax === b1.xMin) col2 = b1.col;
      else col2 = b1.col + Math.trunc(((b0.xMin - b1.xMin) / (b1.xMax - b1.xMin)) * b1.nColumns);
      col1 = Math.max(col1, col2);
    }
    b0.col = col1;
    for (const l of b0.lines) for (let k = 0; k < l.col.length; k++) l.col[k] += col1;
  }
  return sorted;
}

interface Frag {
  line: Line;
  xMin: number;
  yMin: number;
  base: number;
  col: number;
  width: number; // in columns
}

/** Print the lines at their columns, as the physical-layout branch of TextPage::dump. */
function dump(blocks: Block[]): string {
  const frags: Frag[] = blocks.flatMap((blk) =>
    blk.lines
      .filter((l) => l.text.length)
      .map((l) => ({
        line: l,
        xMin: l.edge[0],
        yMin: l.yMin,
        base: l.base,
        col: l.col[0],
        width: l.col[l.text.length] - l.col[0],
      })),
  );
  // Tops within 0.01 count as level (poppler 24.02's cmpYXPrimaryRot).
  frags.sort((a, b) => (Math.abs(a.yMin - b.yMin) < 0.01 ? a.xMin - b.xMin : a.yMin - b.yMin));

  // Fragments on one baseline print left to right by column.
  for (let i = 0; i < frags.length; ) {
    const delta = maxIntraLineDelta * frags[i].line.fontSize;
    const base = frags[i].base;
    let end = i + 1;
    while (end < frags.length && Math.abs(frags[end].base - base) < delta) end++;
    const group = frags.slice(i, end).toSorted((a, b) => {
      const overlap = a.col < b.col + b.width && b.col < a.col + a.width;
      return overlap ? a.yMin - b.yMin : a.col - b.col;
    });
    frags.splice(i, group.length, ...group);
    i = end;
  }

  let out = "";
  let col = 0;
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    if (col < f.col) {
      out += " ".repeat(f.col - col);
      col = f.col;
    }
    out += f.line.text.join("");
    col += f.line.text.length;
    const next = frags[i + 1];
    if (!next) {
      out += "\n";
    } else if (
      next.col < col ||
      Math.abs(next.base - f.base) > maxIntraLineDelta * f.line.fontSize
    ) {
      const d = Math.trunc((next.base - f.base) / f.line.fontSize);
      out += "\n".repeat(Math.min(Math.max(d, 1), 5));
      col = 0;
    }
  }
  return out;
}

/** The page's blocks, each as its lines' text: for comparing with `pdftotext -bbox-layout`. */
export function layoutBlocks(runs: GlyphRun[]): { x: number[]; y: number[]; lines: string[] }[] {
  const pool = new Pool();
  for (const w of buildWords(runs)) pool.add(w);
  return buildBlocks(pool).map((b) => ({
    x: [b.xMin, b.xMax],
    y: [b.yMin, b.yMax],
    lines: b.lines.map((l) => l.text.join("")),
  }));
}

/** Lay out one page's glyph runs as `pdftotext -layout` does. */
export function layoutRuns(runs: GlyphRun[]): string {
  const pool = new Pool();
  for (const w of buildWords(runs)) pool.add(w);
  return dump(assignBlockColumns(buildBlocks(pool)));
}
