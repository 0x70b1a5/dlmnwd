import { expect, test } from "bun:test";
import {
  applyActualText,
  extractPagesEmulated,
  fontMetrics,
  layoutPage,
  pageItems,
  type TextItem,
} from "../src/pdf/emulate.ts";

// emulate.ts turns pdf.js text content into glyph runs for layout.ts. These
// tests pin the conversion: the y flip, /ActualText spans, font metrics, and
// the split of pdf.js items back into glyphs.

/** One item per glyph, 6 units wide, as the patched pdf.js gives them. */
function glyphs(s: string, x: number, y: number): TextItem[] {
  return [...s].map((c, i) => ({ str: c, x: x + i * 6, y, width: 6, height: 10 }));
}

test("lays out items with y growing up", () => {
  const out = layoutPage([...glyphs("top", 0, 700), ...glyphs("next", 0, 688)], 792);
  expect(out).toBe("top\nnext\n");
});

test("replaces the glyphs in an /ActualText span with its text", () => {
  const items = applyActualText([
    ...glyphs("a", 0, 100),
    { type: "beginMarkedContentProps", actualText: "Wd" },
    ...glyphs("wD", 6, 100),
    { type: "endMarkedContent" },
  ]);
  expect(items.map((i) => i.str)).toEqual(["a", "Wd"]);
  expect(items[1]).toMatchObject({ x: 6, width: 12 });
});

test("ends a span at the last glyph's advance", () => {
  const [span] = applyActualText([
    { type: "beginMarkedContentProps", actualText: "ab" },
    { str: "a", x: 0, y: 0, width: 6, advance: 6, height: 10 },
    { str: " ", x: 6, y: 0, width: 3, advance: 5, height: 10 },
    { type: "endMarkedContent" },
  ]);
  expect(span.width).toBe(11);
});

test("drops a span with empty text, and ignores empty runs", () => {
  const items = applyActualText([
    { type: "beginMarkedContentProps", actualText: "" },
    ...glyphs("x", 0, 0),
    { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", actualText: "y" },
    { str: "", x: 50, y: 0, width: 0, height: 10 },
    ...glyphs("z", 60, 0),
    { type: "endMarkedContent" },
  ]);
  expect(items.map((i) => [i.str, i.x])).toEqual([["y", 60]]);
});

test("reads a span inside a span as plain content", () => {
  const items = applyActualText([
    { type: "beginMarkedContentProps", actualText: "outer" },
    { type: "beginMarkedContent" },
    { type: "beginMarkedContentProps", actualText: "inner" },
    ...glyphs("ab", 0, 0),
    { type: "endMarkedContent" },
    { type: "endMarkedContent" },
    ...glyphs("c", 12, 0),
    { type: "endMarkedContent" },
    ...glyphs("d", 30, 0),
  ]);
  expect(items.map((i) => i.str)).toEqual(["outer", "d"]);
  expect(items[0].width).toBe(18);
});

test("reads font descriptor metrics as poppler does", () => {
  expect(fontMetrics(800, -200)).toEqual([0.8, -0.2]);
  expect(fontMetrics(-800, 200)).toEqual([0.8, -0.2]);
  expect(fontMetrics(undefined, undefined)).toEqual([0.95, -0.35]);
  expect(fontMetrics(0, 5000)).toEqual([0.95, -0.35]);
});

/** A fake pdf.js page holding the given text content. */
function page(items: unknown[], styles: Record<string, object> = {}) {
  return {
    view: [0, 0, 612, 792],
    getTextContent: async () => ({ items, styles }),
  };
}

test("splits each pdf.js item into its glyphs", async () => {
  const items = await pageItems(
    page(
      [
        {
          str: "ab",
          transform: [10, 0, 0, 10, 5, 700],
          width: 12,
          height: 10,
          fontName: "f",
          glyphs: [
            { unicode: "a", x: 5, width: 6, advance: 6 },
            { unicode: "b", x: 11, width: 6, advance: 7 },
          ],
        },
      ],
      { f: { descriptorAscent: 700, descriptorDescent: -300 } },
    ),
  );
  expect(items).toEqual([
    {
      str: "a",
      x: 5,
      y: 700,
      width: 6,
      advance: 6,
      height: 10,
      font: "f",
      ascent: 0.7,
      descent: -0.3,
    },
    {
      str: "b",
      x: 11,
      y: 700,
      width: 6,
      advance: 7,
      height: 10,
      font: "f",
      ascent: 0.7,
      descent: -0.3,
    },
  ]);
});

test("spreads the width over the characters without the patch", async () => {
  const items = await pageItems(
    page([{ str: "abc", transform: [10, 0, 0, 10, 0, 0], width: 30, height: 10, fontName: "f" }]),
  );
  expect(items.map((i) => [i.str, i.x, i.width])).toEqual([
    ["a", 0, 10],
    ["b", 10, 10],
    ["c", 20, 10],
  ]);
});

test("skips rotated text and the spaces pdf.js adds for gaps", async () => {
  const items = await pageItems(
    page([
      { str: " ", transform: [10, 0, 0, 10, 0, 0], width: 3, height: 10, fontName: "f" },
      { str: "up", transform: [0, 10, -10, 0, 0, 0], width: 12, height: 10, fontName: "f" },
      { str: "ok", transform: [10, 0, 0, 10, 0, 0], width: 12, height: 10, fontName: "f" },
    ]),
  );
  expect(items.map((i) => i.str)).toEqual(["o", "k"]);
});

/** A one-page PDF in Courier with the given content stream. */
function tinyPdf(content: string): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("reads /ActualText through the patched pdf.js", async () => {
  // The glyphs decode as "wARD"; the span says the text is "Ward".
  const pdf = tinyPdf(
    [
      "BT /F1 10 Tf 1 0 0 1 72 700 Tm (A) Tj",
      "/Span << /ActualText (Ward) >> BDC 1 0 0 1 90 700 Tm (wARD) Tj EMC",
      "1 0 0 1 72 688 Tm (next line) Tj ET",
    ].join("\n"),
  );
  expect(await extractPagesEmulated(pdf)).toEqual(["A Ward\nnext line\n"]);
});
