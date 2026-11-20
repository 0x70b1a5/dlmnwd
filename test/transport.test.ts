import { expect, test } from "bun:test";
import { parseTransport } from "../src/parse/transport.ts";

// Place text at fixed column offsets to mimic pdftotext -layout output.
function at(cols: [number, string][]): string {
  let line = "";
  for (const [x, text] of cols) {
    if (line.length < x) line += " ".repeat(x - line.length);
    line += text;
  }
  return line;
}

// Invented page: a table of beasts sharing its lines with a column of prose on
// the right, numbered stat blocks in that column, then two vehicle tables.
const page = [
  at([
    [20, "DRAUGHT BEASTS"],
    [66, "Beasts on the Fen Road"],
  ]),
  at([
    [0, "Beast"],
    [24, "Cost (gp)"],
    [39, "Load"],
    [51, "Type"],
    [66, "A beast slows on the soft ground, and"],
  ]),
  at([
    [0, "Tallow ox"],
    [28, "60"],
    [38, "6,500"],
    [51, "Hauler"],
    [66, "must be led over the planks."],
  ]),
  at([
    [0, "Marsh pony"],
    [28, "35"],
    [38, "1,800"],
    [50, "Trotter"],
  ]),
  at([[66, "2. Marsh Pony"]]),
  at([
    [0, "Fen strider"],
    [27, "120"],
    [38, "2,200"],
    [50, "Trotter"],
    [66, "Level 2 AC 12 HP 2d8 (9)"],
  ]),
  at([
    [0, "Load: what one carries at its normal pace."],
    [66, "Att Kick (+1, 1d4) Speed 70 Morale 6"],
  ]),
  "",
  at([[40, "LAND HAULAGE"]]),
  at([
    [0, "Vehicle"],
    [16, "Cost (gp)"],
    [32, "AC"],
    [42, "HP"],
    [52, "Speed"],
    [62, "Cargo"],
    [74, "Towed by"],
  ]),
  at([
    [0, "Mud skid"],
    [19, "45"],
    [32, "9"],
    [42, "1d6"],
    [53, "20"],
    [61, "8,000"],
    [74, "2 oxen"],
  ]),
  at([
    [0, "Hand barrow"],
    [19, "8"],
    [32, "8"],
    [42, "1d2"],
    [53, "20"],
    [62, "900"],
    [74, "1 porter"],
  ]),
  "",
  at([[40, "RIVER CRAFT"]]),
  at([
    [0, "Vehicle"],
    [16, "Cost (gp)"],
    [32, "AC"],
    [42, "HP"],
    [52, "Speed"],
    [62, "Cargo"],
    [74, "Boatmen"],
  ]),
  at([
    [0, "Punt"],
    [19, "20"],
    [32, "9"],
    [42, "1d4"],
    [53, "30"],
    [61, "3,000"],
    [74, "1 poler"],
  ]),
  at([
    [0, "Log float"],
    [15, "2gp a log"],
    [32, "8"],
    [42, "2 a log"],
    [53, "10"],
    [60, "150 a log"],
    [74, "1 poler"],
  ]),
].join("\n");

test("reads a beasts table beside prose, with each one's load and type", () => {
  const list = parseTransport([page]);
  const by = (n: string) => list.find((t) => t.name === n);
  expect(by("Tallow ox")).toMatchObject({
    kind: "animal",
    section: "DRAUGHT BEASTS",
    cost: "60",
    load: 6500,
    type: "Hauler",
  });
  expect(by("Marsh pony")).toMatchObject({ load: 1800, type: "Trotter" });
  // The footnote under the table is not a beast.
  expect(list.some((t) => t.name.startsWith("Load"))).toBe(false);
});

test("reads an animal's Speed from its numbered stat block", () => {
  const list = parseTransport([page]);
  expect(list.find((t) => t.name === "Marsh pony")?.speed).toBe(70);
  expect(list.find((t) => t.name === "Tallow ox")?.speed).toBeUndefined();
});

test("reads vehicles: cargo, AC, HP, Speed and any other column by its label", () => {
  const list = parseTransport([page]);
  expect(list.find((t) => t.name === "Mud skid")).toMatchObject({
    kind: "vehicle",
    section: "LAND HAULAGE",
    cost: "45",
    ac: "9",
    hp: "1d6",
    speed: 20,
    load: 8000,
    more: { "Towed by": "2 oxen" },
  });
  expect(list.find((t) => t.name === "Punt")).toMatchObject({
    section: "RIVER CRAFT",
    load: 3000,
    more: { Boatmen: "1 poler" },
  });
});

test("leaves out a row whose cargo is a rate, not a load", () => {
  const list = parseTransport([page]);
  expect(list.some((t) => t.name === "Log float")).toBe(false);
  expect(list.map((t) => t.name)).toEqual([
    "Tallow ox",
    "Marsh pony",
    "Fen strider",
    "Mud skid",
    "Hand barrow",
    "Punt",
  ]);
});

test("a page with no such table gives nothing", () => {
  expect(parseTransport(["Item  Cost (gp)  Weight\nRope  1  10"])).toEqual([]);
});
