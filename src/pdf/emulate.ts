// A browser-friendly emulation of `pdftotext -layout`, built on pdf.js.
//
// The whole parse/ pipeline assumes the fixed-width text that `pdftotext
// -layout` emits. pdf.js gives positioned text items instead. layout.ts lays
// them out with poppler's own rules, so both paths give the parsers the same
// text.

import { layoutRuns } from "./layout.ts";

/** A pdf.js text item, in PDF user space (y grows up). */
export interface TextItem {
  str: string;
  x: number;
  y: number; // baseline
  width: number; // advance width of the whole str, in PDF user units
  advance?: number; // to the next glyph: width plus char and word spacing
  height: number; // font size, in PDF user units
  font?: string;
  ascent?: number; // fraction of the font size; poppler's defaults apply when absent
  descent?: number;
}

/**
 * Render one page's items as fixed-width text, as `pdftotext -layout` does.
 * `top` is the page's top edge in user space; it only sets where baselines
 * fall in poppler's 4-unit line buckets.
 */
export function layoutPage(items: TextItem[], top = 0): string {
  return layoutRuns(
    items.map((it) => ({
      str: it.str,
      x: it.x,
      base: top - it.y,
      width: it.width,
      fontSize: it.height,
      font: it.font ?? "",
      ascent: it.ascent ?? 0.95,
      descent: it.descent ?? -0.35,
    })),
  );
}

/** A marked-content boundary from getTextContent({ includeMarkedContent }). The
 *  patched pdf.js (patches/pdfjs-dist@*.patch) adds the span's /ActualText. */
interface Marker {
  type: string;
  actualText?: string;
}

/**
 * Replace the glyphs inside each /ActualText span with that text, as pdftotext
 * does. A PDF can draw glyphs whose own decoding is wrong (e.g. small-cap glyphs
 * that decode to the wrong case) and give the true text in a span around them.
 * The text takes the place of the span's glyphs, from the first to the end of
 * the last. Spans do not nest: one inside another is read as plain content.
 */
export function applyActualText(items: (TextItem | Marker)[]): TextItem[] {
  const out: TextItem[] = [];
  const levels: boolean[] = []; // per open marked-content level: is it the span?
  let span: { text: string; runs: TextItem[] } | null = null;
  for (const it of items) {
    if ("str" in it) {
      if (!span) out.push(it);
      else if (it.str) span.runs.push(it);
      continue;
    }
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      const opens = it.actualText !== undefined && !span;
      if (opens) span = { text: it.actualText as string, runs: [] };
      levels.push(opens);
    } else if (it.type === "endMarkedContent" && levels.pop() && span) {
      const { text, runs } = span;
      if (text && runs.length) {
        const last = runs[runs.length - 1];
        const end = last.x + (last.advance ?? last.width); // poppler: the last glyph's full advance
        out.push({ ...runs[0], str: text, width: end - runs[0].x });
      }
      span = null;
    }
  }
  return out;
}

/** The parts of a pdf.js page this module reads. The patched pdf.js adds each
 *  item's `glyphs` and each font's `descriptorAscent` / `descriptorDescent`. */
interface PdfPage {
  view: number[];
  getTextContent(opts: { includeMarkedContent: boolean }): Promise<{
    items: unknown[];
    styles: Record<string, { descriptorAscent?: number; descriptorDescent?: number }>;
  }>;
}
interface PdfItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  glyphs?: { unicode: string; x: number; width: number; advance: number }[];
}

/** A font descriptor's /Ascent and /Descent as poppler reads them: sign fixed,
 *  and the defaults for a value that is absent, zero or out of range. */
export function fontMetrics(ascent?: number, descent?: number): [number, number] {
  const a = Math.abs((ascent ?? 0) / 1000);
  const d = -Math.abs((descent ?? 0) / 1000);
  return [a !== 0 && a < 3 ? a : 0.95, d !== 0 && d > -3 ? d : -0.35];
}

/**
 * One page's text, one item per glyph, with /ActualText applied. pdf.js joins
 * glyphs into runs and inserts spaces for gaps; poppler's word and column rules
 * need each glyph's own position, so the runs are split back into glyphs.
 * Horizontal text only.
 */
export async function pageItems(page: PdfPage): Promise<TextItem[]> {
  const content = await page.getTextContent({ includeMarkedContent: true });
  const items: (TextItem | Marker)[] = [];
  for (const raw of content.items) {
    if (!(typeof raw === "object" && raw && "str" in raw)) {
      items.push(raw as Marker);
      continue;
    }
    const i = raw as PdfItem;
    if (!i.glyphs && !i.str.trim()) continue; // a space pdf.js adds for a gap: no glyph
    const [a, b, c, d, x, y] = i.transform;
    if (!(Math.abs(a * d) > Math.abs(b * c) && a > 0)) continue; // rotated text
    const style = content.styles[i.fontName] ?? {};
    const [ascent, descent] = fontMetrics(style.descriptorAscent, style.descriptorDescent);
    const base = { y, height: i.height || Math.abs(d), font: i.fontName, ascent, descent };
    // Without the patch, spread the item's width over its characters.
    const chars = [...i.str];
    const glyphs =
      i.glyphs ??
      chars.map((u, k) => {
        const w = i.width / chars.length;
        return { unicode: u, x: x + k * w, width: w, advance: w };
      });
    for (const g of glyphs)
      items.push({ ...base, str: g.unicode, x: g.x, width: g.width, advance: g.advance });
  }
  return applyActualText(items);
}

/**
 * Extract every page of a PDF as fixed-width text, one string per page — the
 * pdf.js-based, browser-safe analogue of extract.ts's pdftotext call. Accepts a
 * raw byte buffer so it works the same in Bun and in the browser (File → bytes).
 */
export async function extractPagesEmulated(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await task.promise;

  const pages: string[] = [];
  // Sequential (not Promise.all) so each page is cleaned up before the next —
  // keeps peak memory bounded when a large PDF is loaded in the browser.
  // oxlint-disable no-await-in-loop
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    pages.push(layoutPage(await pageItems(page), page.view[3]));
    page.cleanup();
  }
  // oxlint-enable no-await-in-loop
  await task.destroy();
  return pages;
}
