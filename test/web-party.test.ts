import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ParsedClass } from "../src/parse/class.ts";
import { normalizeParty } from "../src/party/model.ts";
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

/** Mount the tab on a saved party of one member, and any other stored keys. */
async function mount(member: object, keys: Record<string, string> = {}): Promise<void> {
  localStorage.clear();
  localStorage.setItem(KEY, JSON.stringify({ members: [member] }));
  for (const [k, v] of Object.entries(keys)) localStorage.setItem(k, v);
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

test("a party from a link takes the place of this one when the user agrees", async () => {
  await mount({ name: "Orla Venn", class: "warden", level: 2, saves: saves(11) });
  const linked = normalizeParty({ members: [{ name: "Bram" }, { name: "Cole" }] }, "test");
  const asked: string[] = [];
  globalThis.confirm = (q?: string) => (asked.push(q ?? ""), false);
  view.offer(linked, "the link");
  expect(stored().name).toBe("Orla Venn");
  expect(asked[0]).toContain("1 member");
  expect(asked[0]).toContain("2 members");
  globalThis.confirm = () => true;
  view.offer(linked, "the link");
  expect(stored().name).toBe("Bram");
  expect(root.textContent).toContain("Imported 2 members from the link");
  byLabel("Undo").click();
  expect(stored().name).toBe("Orla Venn");
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

test("an item moved to the stash leaves the load, and comes back", async () => {
  await mount({
    name: "Orla Venn",
    class: "warden",
    level: 2,
    saves: saves(11),
    items: [{ name: "Tent", qty: 1, weight: 200, slots: 1, where: "stowed" }],
  });
  const place = () => byLabel("Where Tent is") as HTMLSelectElement;
  // The place is in the row's edit line, which the pencil opens.
  expect(byLabel("Where Tent is")).toBeUndefined();
  byLabel("Edit Tent").click();
  expect(byLabel("Done editing Tent").getAttribute("aria-pressed")).toBe("true");
  expect(place().value).toBe("stowed");
  expect(root.querySelector(".load-line")!.textContent).toContain("200");
  place().value = "stashed";
  place().dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(stored().items[0].where).toBe("stashed");
  expect(place().value).toBe("stashed");
  expect(root.querySelector(".load-line")!.textContent).not.toContain("200");
  expect(notes.at(-1)).toBe("Orla Venn: Tent → stashed");
});

// Invented gear and beasts for the gear-by-place tests.
const packRules: PartyRules = {
  ...rules,
  catalog: [
    { name: "Knapsack", kind: "container", weight: 40, capacity: 300, cost: "3", section: "BAGS" },
    { name: "Thimble", kind: "gear", weight: 1, cost: "2cp", section: "TOOLS" },
  ],
  enc: { ...rules.enc, stowContainers: ["knapsack"] },
  transport: [
    { name: "Marsh pony", kind: "animal", section: "BEASTS", cost: "35", load: 1800, speed: 70 },
    { name: "Mud skid", kind: "vehicle", section: "HAULAGE", cost: "45", load: 800 },
  ],
};

const packer = {
  name: "Orla Venn",
  class: "warden",
  level: 2,
  saves: saves(11),
  coins: { pp: 0, gp: 40, sp: 0, cp: 0 },
  items: [
    { id: "i1", name: "Knapsack", ref: "Knapsack", qty: 1, weight: 40, slots: 1, where: "stowed" },
    { id: "i2", name: "Thimble", ref: "Thimble", qty: 1, weight: 1, slots: 0, where: "equipped" },
  ],
  carriers: [{ id: "c1", name: "Bramble", type: "Marsh pony", kind: "animal", load: 1800 }],
};

const choose = async (label: string, value: string): Promise<void> => {
  const el = byLabel(label) as HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
};

test("gear is listed by place, and an item goes into a container or onto an animal", async () => {
  await mount(packer);
  view.setRules(packRules);
  const heads = () => [...root.querySelectorAll("tr.grp")].map((r) => r.textContent ?? "");
  expect(heads().some((t) => t.startsWith("On Bramble"))).toBe(true);
  byLabel("Edit Thimble").click();
  await choose("Where Thimble is", "in:i1");
  expect(stored().items[1]).toMatchObject({ in: "i1", where: "stowed" });
  // Inside the knapsack it is drawn one level in, under it.
  const row = root.querySelector('tr[data-item="i2"]')!;
  expect(row.previousElementSibling?.getAttribute("data-item")).toBe("i1");
  expect(row.querySelector("td.item")!.getAttribute("style") ?? "").toMatch(/--depth: ?1/);
  expect(notes.at(-1)).toContain("Thimble");
  // The knapsack onto the pony: what is in it goes too.
  byLabel("Edit Knapsack").click();
  await choose("Where Knapsack is", "on:c1");
  expect(stored().items.map((i: { where: string }) => i.where)).toEqual(["loaded", "loaded"]);
  expect(root.querySelector(".load-line")!.textContent).not.toContain("41");
});

test("an animal is bought from the book's list and paid for", async () => {
  await mount({ ...packer, carriers: [] });
  view.setRules(packRules);
  await choose("Animal or vehicle", "Marsh pony");
  const named = byLabel("Its name") as HTMLInputElement;
  named.value = "Turnip";
  named.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(stored().carriers).toEqual([
    expect.objectContaining({ name: "Turnip", type: "Marsh pony", load: 1800, speed: 70 }),
  ]);
  expect(stored().coins.gp).toBe(5);
  expect(root.textContent).toContain("3,600 at half Speed");
  byLabel("Edit Turnip").click();
  byLabel("Remove Turnip").click();
  expect(stored().carriers).toEqual([]);
});

test("coins are added, banked and withdrawn from the amounts given", async () => {
  await mount(packer);
  view.setRules(packRules);
  const gp = () => byLabel("gp to add or move") as HTMLInputElement;
  const press = (title: string) => byLabel(title).click();
  gp().value = "6";
  press("Add these to the coins carried");
  expect(stored().coins.gp).toBe(46);
  // The amount is spent: the field is empty again.
  expect(gp().value).toBe("");
  gp().value = "20";
  press("Move these from the coins carried to the bank");
  expect(stored().coins.gp).toBe(26);
  expect(stored().banked.gp).toBe(20);
  gp().value = "30";
  press("Move these from the bank to the coins carried");
  expect(stored().banked.gp).toBe(20);
  expect(root.textContent).toContain("Only 20gp in the bank");
});

const saver = {
  ...packer,
  coins: { pp: 0, gp: 1, sp: 0, cp: 0 },
  banked: { pp: 0, gp: 10, sp: 0, cp: 0 },
};
const buyKnapsack = (): void => {
  (byLabel("Item to add") as HTMLInputElement).value = "Knapsack";
  byLabel("Buy it at the book's price").click();
};

test("the purse to pay from is kept, in this browser, for each member", async () => {
  await mount(saver);
  view.setRules(packRules);
  expect((byLabel("Pay from") as HTMLSelectElement).value).toBe("coins");
  await choose("Pay from", "banked");
  expect(JSON.parse(localStorage.getItem("dlmnwd:pay-from")!)).toEqual({ "Orla Venn": "banked" });
  buyKnapsack();
  expect(stored().banked.gp).toBe(7);
  // Still the bank after the buy, and the item field is empty again.
  expect((byLabel("Pay from") as HTMLSelectElement).value).toBe("banked");
  expect((byLabel("Item to add") as HTMLInputElement).value).toBe("");
  // A new page reads it back.
  await mount(stored(), { "dlmnwd:pay-from": localStorage.getItem("dlmnwd:pay-from")! });
  view.setRules(packRules);
  expect((byLabel("Pay from") as HTMLSelectElement).value).toBe("banked");
});

test("too few coins carried: the error offers the bank when it holds enough", async () => {
  await mount(saver);
  view.setRules(packRules);
  buyKnapsack();
  expect(stored().items.find((i: { name: string }) => i.name === "Knapsack").qty).toBe(1);
  const offer = byLabel("Pay 3gp from the bank");
  expect(offer).toBeDefined();
  // The strip carries the error too, for a narrow screen.
  const strip = root.querySelector(".play-strip .strip-note")!;
  expect(strip.textContent).toContain("That costs 3gp");
  expect(strip.querySelector(".offer")?.textContent).toBe("Pay 3gp from the bank");
  expect(root.querySelector(".party-notes .in-strip")).not.toBeNull();
  offer.click();
  const knapsack = () => stored().items.find((i: { name: string }) => i.name === "Knapsack");
  expect(knapsack().qty).toBe(2);
  expect(stored().banked.gp).toBe(7);
  expect(stored().coins.gp).toBe(1);
  expect(root.querySelector(".strip-note")).toBeNull();
  expect((byLabel("Item to add") as HTMLInputElement).value).toBe("");
});

test("no offer when the bank is short too; the strip's error can be dismissed", async () => {
  await mount({ ...saver, banked: { pp: 0, gp: 2, sp: 0, cp: 0 } });
  view.setRules(packRules);
  buyKnapsack();
  expect(root.querySelector(".offer")).toBeNull();
  expect(root.querySelector(".strip-note")).not.toBeNull();
  byLabel("Dismiss the error").click();
  expect(root.querySelector(".strip-note")).toBeNull();
  expect(root.querySelector(".party-notes")!.textContent).not.toContain("That costs");
});
