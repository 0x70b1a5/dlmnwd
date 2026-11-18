// Keep both: merge two copies of a party that changed apart, against the copy
// they last matched (the base). Members are matched by name, and each member's
// fields one by one. A field changed on one side only takes that side's value;
// the same field changed differently on both sides is a clash. Pure.

import { normalizeParty, type Party, type PC } from "./model.ts";

export type Side = "here" | "there";

/** One thing the merge took from a side: a field, or a whole member. */
export interface Taken {
  /** The member's name; null for the party's own fields. */
  member: string | null;
  /** A field's label, "added" or "removed". */
  what: string;
  side: Side;
}

/** Something both sides changed differently: the merge can't keep both. */
export interface Clash {
  member: string | null;
  what: string;
}

export interface Merge {
  /** The merged party. Where there are clashes, it has this side's values. */
  party: Party;
  taken: Taken[];
  clashes: Clash[];
}

const LABEL: Record<string, string> = {
  name: "Name",
  player: "Player",
  kindred: "Kindred",
  class: "Class",
  level: "Level",
  xp: "XP",
  alignment: "Alignment",
  background: "Background",
  moonSign: "Moon sign",
  affiliation: "Affiliation",
  scores: "Ability scores",
  hp: "HP",
  maxHp: "Max HP",
  acBonus: "AC bonus",
  attack: "Attack",
  saves: "Save Targets",
  magicResistance: "Magic resistance",
  skills: "Skills",
  languages: "Languages",
  items: "Gear",
  coins: "Coins",
  banked: "Banked coins",
  glamours: "Glamours",
  runes: "Runes",
  spells: "Spells",
  prepared: "Prepared spells",
  knacks: "Knacks",
  notes: "Notes",
  persona: "Persona",
  physique: "Physique",
  retainer: "Retainer",
  status: "Status",
  day: "Day",
  encumbrance: "Encumbrance",
};

/** The label for a field, as the dialog shows it. */
export const fieldLabel = (key: string): string => LABEL[key] ?? key;

const byName = (p: Party): Map<string, PC> => new Map(p.members.map((m) => [m.name, m]));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const plain = (m: PC): PC => ({ ...m, updated: undefined });

/**
 * Merge the fields of one record. `base` undefined: both added it, so any field
 * that differs is a clash.
 */
function mergeFields<T extends object>(
  base: T | undefined,
  here: T,
  there: T,
  member: string | null,
  skip: string[],
  out: { taken: Taken[]; clashes: Clash[] },
): T {
  const merged = { ...here } as Record<string, unknown>;
  const h = here as Record<string, unknown>;
  const t = there as Record<string, unknown>;
  const b = base as Record<string, unknown> | undefined;
  const keys = new Set([...Object.keys(h), ...Object.keys(t)]);
  for (const k of keys) {
    if (skip.includes(k) || same(h[k], t[k])) continue;
    if (b && same(h[k], b[k])) {
      merged[k] = t[k];
      out.taken.push({ member, what: fieldLabel(k), side: "there" });
    } else if (b && same(t[k], b[k])) {
      out.taken.push({ member, what: fieldLabel(k), side: "here" });
    } else out.clashes.push({ member, what: fieldLabel(k) });
  }
  return merged as T;
}

/** Merge `here` and `there`, which both changed since they were `base`. */
export function mergeParties(base: Party, here: Party, there: Party): Merge {
  const out = { taken: [] as Taken[], clashes: [] as Clash[] };
  const top = mergeFields(base, here, there, null, ["members"], out);
  const [b, h, t] = [byName(base), byName(here), byName(there)];
  // This side's order, then the members only the other side has, in its order.
  const names = [...h.keys(), ...[...t.keys()].filter((n) => !h.has(n))];
  const members: PC[] = [];
  for (const name of names) {
    const was = b.get(name);
    const mine = h.get(name);
    const theirs = t.get(name);
    if (mine && theirs) {
      const m = mergeFields(was, mine, theirs, name, ["updated"], out);
      const stamps = [mine.updated, theirs.updated].filter((n): n is number => !!n);
      if (stamps.length) m.updated = Math.max(...stamps);
      members.push(m);
      continue;
    }
    const kept = (mine ?? theirs)!;
    const side: Side = mine ? "here" : "there";
    const other: Side = mine ? "there" : "here";
    if (!was) {
      members.push(kept);
      out.taken.push({ member: name, what: "added", side });
    } else if (same(plain(was), plain(kept))) {
      // Removed on the other side, and not changed on this one: it goes.
      out.taken.push({ member: name, what: "removed", side: other });
    } else {
      members.push(kept);
      out.clashes.push({
        member: name,
        what: `removed ${other === "here" ? "here" : "on the account"}, changed ${side === "here" ? "here" : "on the account"}`,
      });
    }
  }
  return {
    party: normalizeParty({ ...top, members }, "The merged party"),
    taken: out.taken,
    clashes: out.clashes,
  };
}
