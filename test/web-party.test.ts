import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ParsedClass } from "../src/parse/class.ts";
import { emptyRules, type PartyRules } from "../src/party/rules.ts";
import type { PartyView } from "../web/party.ts";

// The Party tab in a scripted DOM. Invented names and numbers only.

const saves = (n: number) => ({ doom: n, ray: n + 1, hold: n + 2, blast: n + 3, spell: n + 4 });
const warden: ParsedClass = {
  id: "warden",
  name: "Warden",
  hitDie: "1d6",
  armour: "Any",
  weapons: "Any",
  primeAbilities: ["wis"],
  attack: 0,
  nextLevelXp: 1000,
  saves: saves(12),
  skills: {},
  languages: [],
  traits: [{ name: "Vesper Magic", text: "A warden casts vesper spells." }],
  startingEquipment: null,
  spellBooks: [],
  advancement: [
    { level: 1, xp: 0, hitPoints: "1d6", attack: 0, saves: saves(12), extras: {} },
    { level: 2, xp: 1000, hitPoints: "+1d6", attack: 1, saves: saves(11), extras: {} },
  ],
  spellsPerDay: [[1], [2]],
};
const rules: PartyRules = {
  ...emptyRules(),
  classes: [warden],
  spells: [
    { name: "Lantern Hush", tradition: "Vesper", rank: 1 },
    { name: "Brine Thread", tradition: "Vesper", rank: 1 },
  ],
};

const KEY = "dlmnwd:party";
let root: HTMLElement;
let view: PartyView;
let notes: string[];

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

/** Mount the tab on a saved party of one member. */
async function mount(member: object): Promise<void> {
  localStorage.clear();
  localStorage.setItem(KEY, JSON.stringify({ members: [member] }));
  const { mountParty } = await import("../web/party.ts");
  const { memberSheet } = await import("../web/member-sheet.ts");
  document.body.innerHTML = '<div id="party"></div>';
  root = document.getElementById("party")!;
  notes = [];
  view = mountParty(root, {
    onCount() {},
    sheet: (pc, party, r) => memberSheet(pc, party, r, null),
    onNote: (text) => notes.push(text),
  });
  view.setRules(rules);
}

const stored = () => JSON.parse(localStorage.getItem(KEY)!).members[0];
const byLabel = (label: string) =>
  root.querySelector<HTMLElement>(`[aria-label="${label}"]`) ??
  [...root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === label)!;
/** The input helpers run a change after the focus moves. */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  document.body.innerHTML = "";
});

test("a member with no saves gets the class table's, and the tab says so", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, hp: 5, maxHp: 9 });
  expect(stored().saves).toEqual(saves(11));
  expect(root.textContent).toContain("Save Targets were missing");
  expect(root.textContent).not.toContain("no Save Targets");
});

test("a changed Save Target field is saved and the view keeps the member", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, saves: saves(11) });
  // A closed fold holds no fields until it is opened.
  expect(byLabel("Doom Save Target")).toBeUndefined();
  const edit = root.querySelector<HTMLDetailsElement>(".member__edit")!;
  edit.querySelector("summary")!.click();
  edit.open = true;
  edit.dispatchEvent(new Event("toggle"));
  const doom = byLabel("Doom Save Target") as HTMLInputElement;
  doom.value = "7";
  doom.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(stored().saves.doom).toBe(7);
  expect((byLabel("Doom Save Target") as HTMLInputElement).value).toBe("7");
});

test("prepare, cast and rest change the slots and what the tab shows", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, saves: saves(11) });
  expect(root.textContent).toContain("2 slots free");
  byLabel("Prepare Lantern Hush").click();
  byLabel("Prepare Brine Thread").click();
  expect(stored().prepared).toEqual([
    { name: "Lantern Hush", cast: false },
    { name: "Brine Thread", cast: false },
  ]);
  expect((byLabel("Prepare Lantern Hush") as HTMLButtonElement).disabled).toBe(true);
  expect(root.textContent).toContain("every slot is full");

  byLabel("Cast Lantern Hush").click();
  expect(stored().prepared[0].cast).toBe(true);
  expect(root.querySelector('[aria-label="Cast Lantern Hush"]')).toBeNull();
  expect(notes.at(-1)).toBe("Orla Venn casts Lantern Hush.");

  byLabel("Rest").click();
  expect(stored().prepared[0].cast).toBe(false);
  expect(notes.at(-1)).toContain("1 cast spell ready again");

  byLabel("Clear Brine Thread from its slot").click();
  expect(stored().prepared).toHaveLength(1);
  expect(root.textContent).toContain("1 slot free");
});

test("a change keeps the focus, and the text typed in another part", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, hp: 5, maxHp: 9, saves: saves(11) });
  const xp = root.querySelector<HTMLInputElement>(".party-bar input")!;
  xp.value = "250";
  const heal = byLabel("Heal Orla Venn by 1");
  heal.focus();
  heal.click();
  expect(stored().hp).toBe(6);
  expect(byLabel("Heal Orla Venn by 1")).toBe(heal);
  expect(document.activeElement).toBe(heal);
  expect(root.querySelector<HTMLInputElement>(".party-bar input")!.value).toBe("250");
});

test("undo puts the party back as it was before the last change", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, saves: saves(11) });
  byLabel("Prepare Lantern Hush").click();
  expect(stored().prepared).toHaveLength(1);
  [...root.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").startsWith("Undo"))!
    .click();
  expect(stored().prepared).toEqual([]);
});
