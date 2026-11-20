// Where a member's gear is, and moving it: equipped, stowed, loaded on one of
// the member's animals or vehicles, stashed somewhere safe, or inside another
// item. What is inside an item goes with it. Animals and vehicles come from the
// book's lists and carry a load. The CLI and the web app both use this. Pure:
// the rules are passed in.

import { priceOf } from "../gen/shop.ts";
import type { CatalogItem, EncumbranceRules } from "../parse/gear.ts";
import type { Transport } from "../parse/transport.ts";
import { ANIMAL_LOAD } from "../rules.ts";
import { payCoins } from "./actions.ts";
import { addItem, makeItem, removeItem } from "./items.ts";
import {
  type Carrier,
  COIN_KINDS,
  type Coins,
  type EncMethod,
  freeId,
  type InvItem,
  itemSlots,
  type PC,
  type Where,
} from "./model.ts";
import type { PartyRules } from "./rules.ts";

/** Where an item can go: a place, or inside another item (by its id). */
export type Dest =
  | { where: "equipped" | "stowed" }
  | { where: "stashed"; kept?: string }
  | { where: "loaded"; on: string }
  | { in: string };

/** Where a moved item goes in the list: before or after another, or last. */
export type At = { before: InvItem } | { after: InvItem } | { last: true };

/** The member's two purses: carried coins and banked coins. */
export type Purse = "coins" | "banked";

export function itemById(pc: PC, id: string | undefined): InvItem | undefined {
  return id ? pc.items.find((i) => i.id === id) : undefined;
}

export function carrierById(pc: PC, id: string | undefined): Carrier | undefined {
  return id ? pc.carriers.find((c) => c.id === id) : undefined;
}

/** The item this one is directly inside, if any. */
export function holderOf(pc: PC, item: InvItem): InvItem | undefined {
  return itemById(pc, item.in);
}

/** What is directly inside an item, in list order. */
export function contents(pc: PC, item: InvItem): InvItem[] {
  return item.id ? pc.items.filter((i) => i.in === item.id) : [];
}

/** The item and everything inside it, at any depth. */
export function within(pc: PC, item: InvItem): Set<InvItem> {
  const out = new Set([item]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of pc.items) {
      const h = holderOf(pc, i);
      if (h && out.has(h) && !out.has(i)) {
        out.add(i);
        grew = true;
      }
    }
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this item hold stowed gear: one of the book's stowing containers? */
export function stowsGear(enc: EncumbranceRules, item: InvItem): boolean {
  return enc.stowContainers.some((w) =>
    new RegExp(`^${escape(w)}s?\\b`, "i").test(item.ref ?? item.name),
  );
}

interface Place {
  where: Where;
  on?: string;
  kept?: string;
}

/** The place of what goes inside `box`: in a stowing container, stowed;
 *  otherwise the container's own place. */
function insideOf(box: InvItem, enc: EncumbranceRules): Place {
  if (box.where === "loaded") return { where: "loaded", on: box.on };
  if (box.where === "stashed") return { where: "stashed", kept: box.kept };
  return { where: stowsGear(enc, box) ? "stowed" : box.where };
}

function setPlace(item: InvItem, p: Place): void {
  item.where = p.where;
  if (p.where === "loaded" && p.on) item.on = p.on;
  else delete item.on;
  if (p.where === "stashed" && p.kept) item.kept = p.kept;
  else delete item.kept;
}

/** Give everything inside `item` its place from what it is in. */
function settle(pc: PC, item: InvItem, enc: EncumbranceRules, seen = new Set<InvItem>()): void {
  seen.add(item);
  for (const k of contents(pc, item)) {
    if (seen.has(k)) continue;
    setPlace(k, insideOf(item, enc));
    settle(pc, k, enc, seen);
  }
}

const bulkyError = (item: InvItem): Error =>
  new Error(`${item.name} is bulky: it takes two hands and can't be stowed.`);

/** Where stashed gear is kept, as it reads after "stashed": "the mill" reads
 *  "at the mill", and a place with its own word ("with Bramble") stays. */
export function keptText(kept: string): string {
  return /^(at|in|on|with|by|under|behind|near|inside|beside|among|beneath|below|outside|upon)\s/i.test(
    kept,
  )
    ? kept
    : `at ${kept}`;
}

/** An animal or vehicle by its name, and its type when that is not its name. */
export function carrierText(c: Carrier): string {
  return c.name === c.type ? c.name : `${c.name} (${c.type})`;
}

/** "equipped", "stowed", "on Bramble", "stashed at the inn", "in the Backpack". */
export function placeText(pc: PC, item: InvItem): string {
  const box = holderOf(pc, item);
  if (box) return `in the ${box.name}`;
  if (item.where === "loaded") return `on ${carrierById(pc, item.on)?.name ?? "an animal"}`;
  if (item.where === "stashed") return item.kept ? `stashed ${keptText(item.kept)}` : "stashed";
  return item.where;
}

/**
 * Move an item, and everything inside it, to a place or into another item.
 * With `at`, it also takes that position in the list (the order shown in each
 * place and container). Returns a line saying where it went.
 */
export function moveItem(pc: PC, item: InvItem, to: Dest, enc: EncumbranceRules, at?: At): string {
  if ("in" in to) {
    const box = itemById(pc, to.in);
    if (!box) throw new Error("That container is not in the list.");
    if (within(pc, item).has(box))
      throw new Error(
        `${item.name} can't go inside ${box === item ? "itself" : "something inside it"}.`,
      );
    const place = insideOf(box, enc);
    if (place.where === "stowed" && item.bulky) throw bulkyError(item);
    item.in = box.id;
    setPlace(item, place);
  } else {
    if (to.where === "loaded" && !carrierById(pc, to.on))
      throw new Error("That animal or vehicle is not in the list.");
    if (to.where === "stowed" && item.bulky) throw bulkyError(item);
    delete item.in;
    setPlace(item, to);
  }
  settle(pc, item, enc);
  if (at) {
    const ref = "last" in at ? null : "before" in at ? at.before : at.after;
    if (ref !== item) {
      pc.items.splice(pc.items.indexOf(item), 1);
      const k = ref ? pc.items.indexOf(ref) : -1;
      pc.items.splice(k < 0 ? pc.items.length : k + ("after" in at ? 1 : 0), 0, item);
    }
  }
  return `${item.name} → ${placeText(pc, item)}`;
}

export interface Row {
  item: InvItem;
  /** 0 for an item in a place; 1 inside a container, and so on. */
  depth: number;
}

export interface PlaceGroup {
  /** "equipped", "stowed", "on:c1", "stashed", or "stashed:at the inn". */
  key: string;
  where: Where;
  carrier?: Carrier;
  kept?: string;
  /** Each item in the place, each container followed by what is inside it. */
  rows: Row[];
}

/**
 * The member's gear by place, in the order a sheet shows it: equipped, stowed,
 * each animal or vehicle, then stashed (by where it is kept). Every place is
 * there, empty or not; each place lists its items in list order.
 */
export function placeGroups(pc: PC): PlaceGroup[] {
  const tops = pc.items.filter((i) => !holderOf(pc, i));
  const rows = (list: InvItem[]): Row[] => {
    const out: Row[] = [];
    const seen = new Set<InvItem>();
    const walk = (i: InvItem, depth: number): void => {
      if (seen.has(i)) return;
      seen.add(i);
      out.push({ item: i, depth });
      for (const k of contents(pc, i)) walk(k, depth + 1);
    };
    for (const i of list) walk(i, 0);
    return out;
  };
  const here = (w: Where, test: (i: InvItem) => boolean = () => true): InvItem[] =>
    tops.filter((i) => i.where === w && test(i));
  const groups: PlaceGroup[] = [
    { key: "equipped", where: "equipped", rows: rows(here("equipped")) },
    { key: "stowed", where: "stowed", rows: rows(here("stowed")) },
    ...pc.carriers.map(
      (c): PlaceGroup => ({
        key: `on:${c.id}`,
        where: "loaded",
        carrier: c,
        rows: rows(here("loaded", (i) => i.on === c.id)),
      }),
    ),
    { key: "stashed", where: "stashed", rows: rows(here("stashed", (i) => !i.kept)) },
  ];
  const kept = [...new Set(here("stashed").flatMap((i) => (i.kept ? [i.kept] : [])))];
  for (const k of kept)
    groups.push({
      key: `stashed:${k}`,
      where: "stashed",
      kept: k,
      rows: rows(here("stashed", (i) => i.kept === k)),
    });
  return groups;
}

/** The destination a key names: a group's key, or "in:<id>" for a container. */
export function destOf(key: string): Dest {
  if (key.startsWith("in:")) return { in: key.slice(3) };
  if (key.startsWith("on:")) return { where: "loaded", on: key.slice(3) };
  if (key.startsWith("stashed:")) return { where: "stashed", kept: key.slice(8) };
  if (key === "stashed") return { where: "stashed" };
  return { where: key === "equipped" ? "equipped" : "stowed" };
}

export interface CarrierLoad {
  /** What is on it: coins of weight, or gear slots under the slot method. */
  used: number;
  /** What it carries at its normal Speed. */
  capacity: number;
  /** The most it carries at all: an animal carries more at half Speed. */
  most: number;
  unit: "coins" | "slots";
  state: "normal" | "slow" | "over";
  /** Its Speed with this load, when the book gives its Speed. */
  speed?: number;
}

/** The load on an animal or vehicle against what it carries. Under the slot
 *  method a carrier holds its load divided by the coins to a slot, and the
 *  equipped and stowed distinction does not apply. */
export function carrierLoad(
  pc: PC,
  c: Carrier,
  method: EncMethod,
  enc: EncumbranceRules,
): CarrierLoad {
  const on = pc.items.filter((i) => i.where === "loaded" && i.on === c.id);
  const slots = method === "slots";
  const per = enc.coinsPerSlot > 0 ? enc.coinsPerSlot : 100;
  const used = on.reduce((n, i) => n + (slots ? itemSlots(i) : i.qty * i.weight), 0);
  const capacity = slots ? Math.floor(c.load / per) : c.load;
  const most = c.kind === "animal" ? capacity * ANIMAL_LOAD.halfSpeedTimes : capacity;
  const state = used <= capacity ? "normal" : used <= most ? "slow" : "over";
  const load: CarrierLoad = { used, capacity, most, unit: slots ? "slots" : "coins", state };
  if (c.speed !== undefined)
    load.speed = state === "normal" ? c.speed : state === "slow" ? Math.floor(c.speed / 2) : 0;
  return load;
}

export interface Fill {
  used: number;
  capacity: number;
  unit: "coins" | "slots";
}

/** How full a container is, when the book says what it holds: gear slots for
 *  a stowing container under the slot method, else coins of weight. */
export function containerFill(
  pc: PC,
  item: InvItem,
  method: EncMethod,
  enc: EncumbranceRules,
  catalog: CatalogItem[],
): Fill | null {
  const inside = [...within(pc, item)].filter((i) => i !== item);
  const n = Math.max(1, item.qty);
  if (method === "slots" && enc.slotsPerContainer > 0 && stowsGear(enc, item))
    return {
      used: inside.reduce((s, i) => s + itemSlots(i), 0),
      capacity: enc.slotsPerContainer * n,
      unit: "slots",
    };
  const cap = catalog.find((c) => c.name === item.ref)?.capacity;
  if (!cap) return null;
  return {
    used: inside.reduce((s, i) => s + i.qty * i.weight, 0),
    capacity: cap * n,
    unit: "coins",
  };
}

/** "1,200 coins", "6 slots". */
export function amountText(n: number, unit: "coins" | "slots"): string {
  return `${n.toLocaleString("en")} ${unit === "slots" ? (n === 1 ? "slot" : "slots") : n === 1 ? "coin" : "coins"}`;
}

/** The key of the group a loose item is in ("on:c1", "stashed:at the inn"). */
export function groupKey(item: InvItem): string {
  if (item.where === "loaded") return `on:${item.on}`;
  if (item.where === "stashed") return item.kept ? `stashed:${item.kept}` : "stashed";
  return item.where;
}

/** A place's name for a sentence: "equipped", "on Bramble", "stashed at the inn". */
export function keyText(pc: PC, key: string): string {
  if (key.startsWith("in:")) return `in the ${itemById(pc, key.slice(3))?.name ?? "container"}`;
  if (key.startsWith("on:")) return `on ${carrierById(pc, key.slice(3))?.name ?? "an animal"}`;
  if (key.startsWith("stashed:")) return `stashed ${keptText(key.slice(8))}`;
  return key;
}

/** An item's place as a key ("in:i2", "on:c1", "stowed"), as destOf reads it. */
export function placeKey(item: InvItem): string {
  if (item.in) return `in:${item.in}`;
  if (item.where === "loaded") return `on:${item.on}`;
  return item.where;
}

/** The items that can hold this one: containers the book gives a capacity in
 *  coins, and anything already holding something; never the item or what is
 *  inside it. (Dragging puts anything inside anything.) */
export function holdersFor(pc: PC, item: InvItem | null, catalog: CatalogItem[]): InvItem[] {
  const out = item ? within(pc, item) : new Set<InvItem>();
  const holds = (i: InvItem): boolean => {
    const c = catalog.find((x) => x.name === i.ref);
    return !!c?.capacity || contents(pc, i).length > 0;
  };
  const now = item ? holderOf(pc, item) : undefined;
  return pc.items.filter((i) => i.id && !out.has(i) && (holds(i) || i === now));
}

/** Find one of the member's animals or vehicles by its name or the book's. */
export function findCarrier(pc: PC, query: string): Carrier {
  const q = query.trim().toLowerCase();
  const all = pc.carriers;
  const tiers = [
    all.filter((c) => c.name.toLowerCase() === q),
    all.filter((c) => c.name.toLowerCase().startsWith(q) || c.type.toLowerCase() === q),
    all.filter((c) => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new Error(
        `"${query}" matches ${hits.map((c) => c.name).join(", ")}; be more specific.`,
      );
  }
  throw new Error(`${pc.name} has no animal or vehicle matching "${query}".`);
}

/** The book's entry for a name: exact, then prefix, then substring. */
export function findTransport(list: Transport[], query: string): Transport {
  const q = query.trim().toLowerCase();
  const hit =
    list.find((t) => t.name.toLowerCase() === q) ??
    list.find((t) => t.name.toLowerCase().startsWith(q)) ??
    list.find((t) => t.name.toLowerCase().includes(q));
  if (!q || !hit)
    throw new Error(
      list.length
        ? `"${query}" isn't one of the book's animals or vehicles.`
        : "The book's animals and vehicles weren't found.",
    );
  return hit;
}

/** Add an animal or vehicle from the book's list. A second of the same gets a
 *  number ("Marsh pony 2") unless it is named. */
export function addCarrier(pc: PC, t: Transport, name?: string): Carrier {
  const ids = new Set(pc.carriers.map((c) => c.id));
  const names = new Set(pc.carriers.map((c) => c.name.toLowerCase()));
  let label = name?.trim() || t.name;
  for (let n = 2; !name?.trim() && names.has(label.toLowerCase()); n++) label = `${t.name} ${n}`;
  const c: Carrier = {
    id: freeId(ids, "c"),
    name: label,
    type: t.name,
    kind: t.kind,
    load: t.load,
  };
  if (t.speed !== undefined) c.speed = t.speed;
  pc.carriers.push(c);
  return c;
}

/** Take an animal or vehicle off the list. What was on it is stashed, kept
 *  under its name, so nothing is lost. */
export function removeCarrier(pc: PC, c: Carrier): string {
  const load = pc.items.filter((i) => i.where === "loaded" && i.on === c.id);
  for (const i of load) setPlace(i, { where: "stashed", kept: `with ${c.name}` });
  pc.carriers = pc.carriers.filter((x) => x !== c);
  return load.length
    ? `${pc.name}: ${c.name} goes; what was on it is stashed with ${c.name}`
    : `${pc.name}: ${c.name} goes`;
}

/** "12gp 5sp" for a purse or change. */
export function coinsLine(c: Coins): string {
  return (
    COIN_KINDS.filter((k) => c[k])
      .map((k) => `${c[k]}${k}`)
      .join(" ") || "nothing"
  );
}

const PURSE: Record<Purse, string> = { coins: "carried coins", banked: "banked coins" };

/** Pay a price in copper from a purse; a line saying what was paid and the change. */
function pay(pc: PC, cp: number, purse: Purse): string {
  const { paid, change } = payCoins(pc[purse], cp, `${pc.name}'s ${PURSE[purse]}`);
  const back = COIN_KINDS.some((k) => change[k]) ? `, change ${coinsLine(change)}` : "";
  return `paid ${coinsLine(paid)}${purse === "banked" ? " from the bank" : ""}${back}`;
}

/** Buy an item from the book's lists at its listed price. `qty` is how many
 *  are wanted; an item sold several to a price is bought in whole lots. */
export function buyItem(
  pc: PC,
  rules: PartyRules,
  query: string,
  opts: { qty?: number; to?: Dest; purse?: Purse } = {},
): { inv: InvItem; line: string } {
  const { inv, resolved } = makeItem(rules.catalog, rules.enc, query, { qty: opts.qty });
  const item = resolved.item;
  if (!item) throw new Error(`"${query}" isn't in the book's lists, so it has no price. Add it.`);
  const price = priceOf(item.cost);
  if (!price) throw new Error(`${item.name} has no price in the book. Add it.`);
  const lots = Math.max(1, Math.ceil(inv.qty / price.units));
  inv.qty = lots * price.units;
  if (opts.to) moveItem(pc, inv, opts.to, rules.enc);
  const paid = pay(pc, lots * price.cp, opts.purse ?? "coins");
  const kept = addItem(pc, inv);
  return { inv: kept, line: `${pc.name} buys ${inv.qty} × ${inv.name}: ${paid}` };
}

/** Buy an animal or vehicle from the book's list at its listed price. */
export function buyCarrier(
  pc: PC,
  t: Transport,
  opts: { name?: string; purse?: Purse } = {},
): { carrier: Carrier; line: string } {
  const price = priceOf(t.cost);
  if (!price) throw new Error(`${t.name} has no single price in the book. Add it.`);
  const paid = pay(pc, price.cp, opts.purse ?? "coins");
  const carrier = addCarrier(pc, t, opts.name);
  return { carrier, line: `${pc.name} buys ${carrierText(carrier)}: ${paid}` };
}

/** What a shop sells: the book's equipment lists, then its animals and vehicles. */
export function shopCatalog(rules: Pick<PartyRules, "catalog" | "transport">): CatalogItem[] {
  const listed = new Set(rules.catalog.map((c) => c.name.toLowerCase()));
  return [
    ...rules.catalog,
    ...transportForSale(rules.transport).filter((t) => !listed.has(t.name.toLowerCase())),
  ];
}

/** The book's animals and vehicles as items with a price, for a shop. */
export function transportForSale(list: Transport[]): CatalogItem[] {
  return list
    .filter((t) => priceOf(t.cost))
    .map((t) => ({
      name: t.name,
      kind: "gear",
      weight: 0,
      section: t.section,
      cost: t.cost,
      capacity: t.load,
    }));
}

// ── Sell, split, duplicate ────────────────────────────────────────────────

/** The most rows Split makes at once. */
export const SPLIT_MAX = 100;

/**
 * Sell `qty` of an item (all of it when omitted) for what the buyer pays,
 * into the coins carried. The book gives no rate to sell at: the referee says
 * what it fetches. What was inside a row that goes stays, one level up.
 */
export function sellItem(pc: PC, item: InvItem, got: Coins, qty?: number): string {
  if (qty !== undefined && !(Number.isInteger(qty) && qty >= 1))
    throw new Error("Sell one or more.");
  if (COIN_KINDS.some((k) => !(Number.isInteger(got[k]) && got[k] >= 0)))
    throw new Error("What the buyer pays is whole coins, none less than 0.");
  if (qty !== undefined && qty > item.qty)
    throw new Error(
      `There ${item.qty === 1 ? "is" : "are"} only ${item.qty} × ${item.name} to sell.`,
    );
  const n = qty ?? item.qty;
  // A row that goes leaves what was in it where the row was.
  const out =
    n === item.qty && contents(pc, item).length
      ? `; what was in it stays, ${placeText(pc, item)}`
      : "";
  for (const k of COIN_KINDS) pc.coins[k] += got[k];
  removeItem(pc, item, n);
  return `${pc.name} sells ${n} × ${item.name} for ${coinsLine(got)}${out}`;
}

/** A stack becomes rows of one: the item itself is the first, and the others
 *  come right after it. What is inside it stays in the first. */
export function splitItem(pc: PC, item: InvItem): string {
  const q = item.qty;
  if (q < 2) throw new Error(`There is only one ${item.name}.`);
  if ((item.per ?? 1) > 1)
    throw new Error(`${item.name} share their slots as one stack, so they are not split.`);
  if (q > SPLIT_MAX) throw new Error(`Split makes a row for each one: ${SPLIT_MAX} at most.`);
  const taken = new Set(pc.items.flatMap((i) => (i.id ? [i.id] : [])));
  item.qty = 1;
  const rows = Array.from({ length: q - 1 }, () => ({
    ...structuredClone(item),
    id: freeId(taken, "i"),
  }));
  pc.items.splice(pc.items.indexOf(item) + 1, 0, ...rows);
  return `${pc.name} splits ${q} × ${item.name} into ${q} rows of one`;
}

/** Another row just like an item, right after it, with a copy of everything
 *  inside it. */
export function duplicateItem(pc: PC, item: InvItem): string {
  const taken = new Set(pc.items.flatMap((i) => (i.id ? [i.id] : [])));
  const ids = new Map<string, string>();
  const copy = (o: InvItem): InvItem => {
    const c = structuredClone(o);
    c.id = freeId(taken, "i");
    if (o.id) ids.set(o.id, c.id);
    return c;
  };
  const below = within(pc, item);
  const top = copy(item);
  const inside = pc.items.filter((o) => o !== item && below.has(o)).map(copy);
  for (const c of inside) if (c.in) c.in = ids.get(c.in) ?? c.in;
  pc.items.splice(pc.items.indexOf(item) + 1, 0, top, ...inside);
  const what = item.qty > 1 ? `${item.qty} × ${item.name}` : item.name;
  const more = inside.length
    ? `, and the ${inside.length === 1 ? "one thing" : `${inside.length} things`} in it`
    : "";
  return `${pc.name} duplicates ${what}${more}`;
}

/** Set or clear an item's note. */
export function noteItem(pc: PC, item: InvItem, text: string): string {
  const t = text.trim();
  if (t) item.note = t;
  else delete item.note;
  return t ? `${pc.name}: ${item.name} (${t})` : `${pc.name}: ${item.name}, no note`;
}
