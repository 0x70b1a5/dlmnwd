import { expect, test } from "bun:test";
import { mergeParties } from "../src/party/merge.ts";
import { normalizeParty } from "../src/party/model.ts";

// Invented names only.

const party = (raw: object) => normalizeParty(raw, "test");
const names = (p: { members: { name: string }[] }) => p.members.map((m) => m.name);

const base = party({
  day: 2,
  members: [
    { name: "Orla Venn", hp: 5, maxHp: 9, xp: 100 },
    { name: "Bram", hp: 4, maxHp: 4 },
    { name: "Cole", hp: 6, maxHp: 6 },
  ],
});

test("fields changed on one side each take that side's value", () => {
  const here = structuredClone(base);
  here.members[0].hp = 9; // healed here
  here.members[0].updated = 10;
  here.members.push({ ...structuredClone(base.members[1]), name: "Dell" }); // added here
  const there = structuredClone(base);
  there.members[0].xp = 300; // XP on the account
  there.members[0].updated = 20;
  there.day = 3;
  there.members = there.members.filter((m) => m.name !== "Cole"); // removed on the account
  const m = mergeParties(base, here, there);
  expect(m.clashes).toEqual([]);
  expect(names(m.party)).toEqual(["Orla Venn", "Bram", "Dell"]);
  expect(m.party.members[0]).toMatchObject({ hp: 9, xp: 300, updated: 20 });
  expect(m.party.day).toBe(3);
  expect(m.taken).toEqual([
    { member: null, what: "Day", side: "there" },
    { member: "Orla Venn", what: "XP", side: "there" },
    { member: "Orla Venn", what: "HP", side: "here" },
    { member: "Cole", what: "removed", side: "there" },
    { member: "Dell", what: "added", side: "here" },
  ]);
});

test("the same field changed on both sides is a clash", () => {
  const here = structuredClone(base);
  here.members[0].hp = 9;
  const there = structuredClone(base);
  there.members[0].hp = 2;
  there.members[1].xp = 50;
  const m = mergeParties(base, here, there);
  expect(m.clashes).toEqual([{ member: "Orla Venn", what: "HP" }]);
  expect(m.party.members[0].hp).toBe(9); // this side's, where it clashes
  expect(m.party.members[1].xp).toBe(50);
});

test("a member removed on one side and changed on the other is a clash", () => {
  const here = structuredClone(base);
  here.members[2].hp = 1;
  const there = structuredClone(base);
  there.members = there.members.filter((m) => m.name !== "Cole");
  const m = mergeParties(base, here, there);
  expect(m.clashes).toEqual([{ member: "Cole", what: "removed on the account, changed here" }]);
});

test("the same change on both sides is no clash, and a member both added differently clashes", () => {
  const here = structuredClone(base);
  const there = structuredClone(base);
  here.members[1].hp = 1;
  there.members[1].hp = 1;
  here.members.push(party({ members: [{ name: "Eve", xp: 1 }] }).members[0]);
  there.members.push(party({ members: [{ name: "Eve", xp: 2 }] }).members[0]);
  const m = mergeParties(base, here, there);
  expect(m.clashes).toEqual([{ member: "Eve", what: "XP" }]);
  expect(m.taken).toEqual([]);
});
