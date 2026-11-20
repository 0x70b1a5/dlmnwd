// The party model: the player characters a table is running. Pure (no Node
// APIs), so the web app and the CLI share it. store.ts saves it to a file;
// the web app saves it in the browser.

export const ABILITIES = ["str", "int", "wis", "dex", "con", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

/** Equipped and stowed gear is carried. Loaded gear is on one of the
 *  member's animals or vehicles (`on`). Stashed gear is left somewhere safe
 *  (an inn, a camp): it stays on the list and weighs nothing. */
export type Where = "equipped" | "stowed" | "loaded" | "stashed";
/** The places that need nothing more said: all but loaded, which names its carrier. */
export const WHERES: readonly Where[] = ["equipped", "stowed", "stashed"];

export interface InvItem {
  /** As the player wrote it (or the catalog name when added by lookup). */
  name: string;
  /** The equipment-list entry it resolved to, when it did. */
  ref?: string;
  qty: number;
  /** Weight in coins of one unit. */
  weight: number;
  /** Gear slots one unit occupies (slot encumbrance). */
  slots: number;
  /** Units that share those slots (20 loose sling stones fill one). Default 1. */
  per?: number;
  where: Where;
  /** Counts as treasure (basic encumbrance), e.g. a gem or a potion. */
  treasure?: boolean;
  /** Bulky (two hands to carry): can't be stowed in a container. */
  bulky?: boolean;
  note?: string;
  /** Its id in the member's list ("i3"), for what goes inside it. */
  id?: string;
  /** The id of the item it is inside. */
  in?: string;
  /** Loaded: the id of the animal or vehicle it is on. */
  on?: string;
  /** Stashed: where it is kept ("at the inn"). */
  kept?: string;
}

/** An animal or vehicle a member owns, to carry gear (party/inventory.ts). */
export interface Carrier {
  /** Its id in the member's list ("c1"); a loaded item names it in `on`. */
  id: string;
  /** What the player calls it: the book's name until they rename it. */
  name: string;
  /** The book's entry it is. */
  type: string;
  kind: "animal" | "vehicle";
  /** Coins of weight it carries: an animal at its normal Speed, a vehicle at all. */
  load: number;
  speed?: number;
  note?: string;
}

/** Gear slots an inventory entry fills. */
export function itemSlots(i: InvItem): number {
  return Math.ceil(i.qty / Math.max(1, i.per ?? 1)) * i.slots;
}

export interface Coins {
  cp: number;
  sp: number;
  gp: number;
  pp: number;
}

export const COIN_KINDS = ["pp", "gp", "sp", "cp"] as const;
export type CoinKind = (typeof COIN_KINDS)[number];

export interface KnownRune {
  name: string;
  magnitude: string;
  /** Usage multiplier: a duplicate grant doubles the uses allowed. */
  times: number;
  /** Each use, stamped with the party day and the caster's level at the time. */
  uses: { day: number; level: number }[];
}

export interface PreparedSpell {
  name: string;
  /** Cast today: the slot is spent until the next rest. */
  cast: boolean;
}

export interface Saves {
  doom: number;
  ray: number;
  hold: number;
  blast: number;
  spell: number;
}

export interface PC {
  name: string;
  player: string;
  kindred: string; // kindred id
  class: string; // class id
  level: number;
  xp: number;
  alignment: string;
  background: string;
  moonSign: string;
  affiliation: string;
  scores: Record<Ability, number>;
  hp: number;
  maxHp: number;
  /** AC on top of worn armour + shield + DEX (natural armour, magic, …). */
  acBonus: number;
  attack: number;
  saves: Saves;
  magicResistance: number;
  skills: Record<string, number>;
  languages: string[];
  items: InvItem[];
  /** Animals and vehicles that carry the member's gear. */
  carriers: Carrier[];
  coins: Coins;
  /** Coins held somewhere safe (not carried, no encumbrance). */
  banked: Coins;
  glamours: string[];
  runes: KnownRune[];
  spells: string[];
  /** The spells made ready for the day, one entry for each slot they fill. */
  prepared: PreparedSpell[];
  knacks: string[];
  notes: string[];
  /** Rolled persona fields by name (appearance, manner, …), when generated. */
  persona: Record<string, string>;
  /** Rolled body stats (age, height, weight, lifespan), when generated. */
  physique: Record<string, string>;
  /** An adventurer retainer: counts for XP division, earns half. */
  retainer: boolean;
  status: "active" | "retired" | "dead";
  /** When a change last touched this member (ms since 1970), where it is known. */
  updated?: number;
}

export type EncMethod = "weight" | "slots" | "basic";
export const ENC_METHODS: EncMethod[] = ["weight", "slots", "basic"];

export interface Party {
  version: 1;
  encumbrance: EncMethod;
  /** Days elapsed in the campaign; rune usage periods count against it. */
  day: number;
  members: PC[];
}

export function emptyCoins(): Coins {
  return { cp: 0, sp: 0, gp: 0, pp: 0 };
}

export function freshParty(): Party {
  return { version: 1, encumbrance: "weight", day: 1, members: [] };
}

/** A blank PC with every field present, for importers to fill in. */
export function blankPc(name: string): PC {
  return {
    name,
    player: "",
    kindred: "",
    class: "",
    level: 1,
    xp: 0,
    alignment: "",
    background: "",
    moonSign: "",
    affiliation: "",
    scores: { str: 10, int: 10, wis: 10, dex: 10, con: 10, cha: 10 },
    hp: 1,
    maxHp: 1,
    acBonus: 0,
    attack: 0,
    saves: { doom: 0, ray: 0, hold: 0, blast: 0, spell: 0 },
    magicResistance: 0,
    skills: {},
    languages: [],
    items: [],
    carriers: [],
    coins: emptyCoins(),
    banked: emptyCoins(),
    glamours: [],
    runes: [],
    spells: [],
    prepared: [],
    knacks: [],
    notes: [],
    persona: {},
    physique: {},
    retainer: false,
    status: "active",
  };
}

/** Find a member by name: exact, then prefix, then substring (case-insensitive),
 *  matching whole name or any word of it. Throws on no match or an ambiguity. */
export function findMember(party: Party, query: string): PC {
  const q = query.trim().toLowerCase();
  const all = party.members;
  const tiers = [
    all.filter((m) => m.name.toLowerCase() === q),
    all.filter(
      (m) =>
        m.name.toLowerCase().startsWith(q) ||
        m.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(q)),
    ),
    all.filter((m) => m.name.toLowerCase().includes(q)),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new Error(
        `"${query}" matches ${hits.map((m) => m.name).join(", ")}; be more specific.`,
      );
  }
  const names = all.map((m) => m.name).join(", ") || "(the party is empty)";
  throw new Error(`No party member matches "${query}". Members: ${names}`);
}

export function activeMembers(party: Party): PC[] {
  return party.members.filter((m) => m.status === "active");
}

/**
 * Check a parsed party file and fill any field added since it was saved, so an
 * older file keeps working. `source` names the file in the error messages.
 */
export function normalizeParty(raw: unknown, source: string): Party {
  if (!raw || typeof raw !== "object") throw new Error(`${source} is not a party file.`);
  const p = raw as Partial<Party>;
  if (!Array.isArray(p.members)) throw new Error(`${source} has no members list.`);
  if (p.members.some((m) => !m || typeof m !== "object" || typeof m.name !== "string"))
    throw new Error(`${source} has a member without a name.`);
  const members = p.members.map((m) => Object.assign(blankPc(m.name), m));
  for (const m of members) tidyInventory(m);
  return { ...freshParty(), ...p, members };
}

/** A free id with this prefix ("i" for items, "c" for carriers). */
export function freeId(taken: Set<string>, prefix: string): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  taken.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

/**
 * Make a member's gear hang together: every item and carrier has its own id,
 * an item is inside only an item that is there (and never inside itself), a
 * loaded item names a carrier that is there, and what is inside a loaded or
 * stashed item is in the same place. Older files gain ids. Changes `pc`.
 */
export function tidyInventory(pc: PC): void {
  const cids = new Set<string>();
  pc.carriers = (pc.carriers ?? []).filter((c) => c && typeof c === "object");
  for (const c of pc.carriers) {
    if (!c.id || cids.has(c.id)) c.id = freeId(cids, "c");
    else cids.add(c.id);
    c.name ||= c.type || "Animal";
    c.load = Number(c.load) || 0;
  }
  const ids = new Set<string>();
  for (const i of pc.items) {
    if (!i.id || ids.has(i.id)) i.id = freeId(ids, "i");
    else ids.add(i.id);
  }
  const byId = new Map(pc.items.map((i) => [i.id!, i]));
  const holder = (i: InvItem): InvItem | undefined => (i.in ? byId.get(i.in) : undefined);
  for (const i of pc.items) {
    if (!i.in) continue;
    // Up the chain: a missing holder or a loop takes it out.
    const seen = new Set([i.id]);
    for (let h = holder(i); h; h = holder(h)) {
      if (seen.has(h.id)) {
        delete i.in;
        break;
      }
      seen.add(h.id);
    }
    if (i.in && !byId.has(i.in)) delete i.in;
  }
  for (const i of pc.items) {
    if (i.in) continue;
    if (i.where === "loaded" && !cids.has(i.on ?? "")) i.where = "stashed";
    settleInside(pc, i);
  }
}

/** Contents of a loaded or stashed item are on the same carrier or kept at the
 *  same place; contents of a carried item are carried. */
const off = (w: Where): boolean => w === "loaded" || w === "stashed";

function settleInside(pc: PC, top: InvItem): void {
  const walk = (i: InvItem): void => {
    if (i !== top) {
      if (off(top.where)) i.where = top.where;
      else if (off(i.where)) i.where = "stowed";
    }
    if (i.where === "loaded") i.on = top.on;
    else delete i.on;
    if (i.where !== "stashed") delete i.kept;
    else if (i !== top) {
      if (top.kept) i.kept = top.kept;
      else delete i.kept;
    }
    for (const k of pc.items) if (k.in === i.id && k !== top) walk(k);
  };
  walk(top);
}

const plain = (m: PC): string => JSON.stringify({ ...m, updated: undefined });

/** Stamp the members a change touched (by name) with `now`. A member with a new
 *  name counts as touched. */
export function stampChanged(before: Party, after: Party, now: number): void {
  const was = new Map(before.members.map((m) => [m.name, plain(m)]));
  for (const m of after.members) if (was.get(m.name) !== plain(m)) m.updated = now;
}
