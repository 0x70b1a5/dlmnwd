import { expect, test } from "bun:test";
import { partyDiff } from "../src/party/diff.ts";
import { normalizeParty, stampChanged } from "../src/party/model.ts";

// Invented names only.

const party = (raw: object) => normalizeParty(raw, "test");

test("members are matched by name, and each change reads here → there", () => {
  const here = party({
    day: 2,
    members: [
      {
        name: "Orla Venn",
        xp: 100,
        coins: { gp: 12 },
        spells: ["Lantern Hush"],
        items: [{ name: "Cord", qty: 1, weight: 5, slots: 1, where: "stowed" }],
      },
      { name: "Bram" },
      { name: "Cole", updated: 5 },
    ],
  });
  const there = party({
    day: 2,
    members: [
      {
        name: "Orla Venn",
        xp: 250,
        coins: { gp: 2, sp: 5 },
        spells: ["Lantern Hush", "Brine Thread"],
        items: [{ name: "Cord", qty: 2, weight: 5, slots: 1, where: "stowed" }],
      },
      { name: "Cole", updated: 9 },
      { name: "Dell" },
    ],
  });
  const d = partyDiff(here, there);
  expect(d.party).toEqual([]);
  expect(d.members.map((m) => [m.name, m.kind])).toEqual([
    ["Orla Venn", "changed"],
    ["Bram", "here"],
    ["Cole", "same"], // only the change time differs
    ["Dell", "there"],
  ]);
  expect(d.members[0].changes).toEqual([
    "XP: 100 → 250",
    "Coins: 12gp → 2gp 5sp",
    "Gear only here: Cord (stowed)",
    "Gear only there: Cord ×2 (stowed)",
    "Spells only there: Brine Thread",
  ]);
});

test("a change stamps only the members it touched", () => {
  const before = party({
    members: [
      { name: "Orla Venn", hp: 3 },
      { name: "Bram", updated: 7 },
    ],
  });
  const after = party({
    members: [{ name: "Orla Venn", hp: 4 }, { name: "Bram", updated: 7 }, { name: "Cole" }],
  });
  stampChanged(before, after, 100);
  expect(after.members.map((m) => m.updated)).toEqual([100, 7, 100]);
});
