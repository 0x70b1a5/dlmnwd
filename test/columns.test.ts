import { expect, test } from "bun:test";
import { reflowColumns, splitProseColumns, splitTwoColumns } from "../src/pdf/columns.ts";

// Place text at fixed column offsets to mimic pdftotext -layout / emulated output.
function at(cols: [number, string][]): string {
  let line = "";
  for (const [x, text] of cols) {
    if (line.length < x) line += " ".repeat(x - line.length);
    line += text;
  }
  return line;
}

test("splitProseColumns separates columns even when a left line runs wide", () => {
  const page = [
    at([
      [0, "ALPHA TRAIT"],
      [50, "BETA SECTION"],
    ]),
    at([
      [0, "alpha one short"],
      [50, "beta one on the right side here"],
    ]),
    at([
      [0, "alpha two runs much wider across the page"],
      [50, "beta two on the right side too"],
    ]),
    at([
      [0, "alpha three"],
      [50, "beta three on the right side now"],
    ]),
    at([
      [0, "alpha four"],
      [50, "beta four on the right side ok"],
    ]),
    at([
      [0, "alpha five"],
      [50, "beta five on the right side go"],
    ]),
    at([
      [0, "alpha six"],
      [50, "beta six on the right side end"],
    ]),
  ].join("\n");
  const [left, right] = splitProseColumns(page);
  // The wide left line must not drag the right column's words across.
  expect(left).toContain("alpha two runs much wider across the page");
  expect(left).not.toContain("beta");
  expect(right).toContain("beta two on the right side too");
  expect(right).not.toContain("alpha");
});

test("splitTwoColumns hard mode slices a bridging line soft mode keeps whole", () => {
  const norm = (n: number) =>
    at([
      [0, `left${n}`],
      [10, `right${n}`],
    ]);
  // The last line's text runs continuously across the gutter (no gap).
  const page = [
    norm(1),
    norm(2),
    norm(3),
    norm(4),
    norm(5),
    norm(6),
    norm(7),
    norm(8),
    "leftbridgeright",
  ].join("\n");

  const soft = splitTwoColumns(page);
  const hard = splitTwoColumns(page, true);

  // Soft: a bridging line is protected (kept whole on the left, blank on the right).
  expect(soft[0].split("\n").at(-1)).toBe("leftbridgeright");
  expect(soft[1].split("\n").at(-1)).toBe("");

  // Hard: the same line is sliced at the gutter, so the right side is preserved.
  expect(hard[0].split("\n").at(-1)).toBe("leftb");
  expect(hard[1].split("\n").at(-1)?.trim()).toBe("ridgeright");
});

test("reflowColumns keeps a line that crosses the gutter whole", () => {
  const rows: [string, string][] = [
    ["left one", "right one"],
    ["left two", "right two"],
    ["left three", "right three"],
    ["left four", "right four"],
    ["left five", "right five"],
    ["left six", "right six"],
    ["left seven", "right seven"],
    ["left eight", "right eight"],
    ["left nine", "right nine"],
    ["left ten", "right ten"],
    ["left eleven", "right eleven"],
    ["left twelve", "right twelve"],
  ];
  const page = [
    // A running header that sits across the gutter, as some books set it.
    at([[30, "Part Nine | Testing"]]),
    ...rows.map(([l, r]) =>
      at([
        [0, l],
        [40, r],
      ]),
    ),
  ].join("\n");
  const lines = reflowColumns(page)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);
  expect(lines[0]).toBe("Part Nine | Testing");
  expect(lines).not.toContain("esting");
  expect(lines.slice(1, 13)).toEqual(rows.map(([l]) => l));
  expect(lines.slice(13)).toEqual(rows.map(([, r]) => r));
});
