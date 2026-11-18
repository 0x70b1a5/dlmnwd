// What differs between two copies of a party: this browser's and the one kept
// elsewhere. Members are matched by name. Each change reads "here → there".
// Pure.

import { ABILITIES, type Coins, type InvItem, type Party, type PC } from "./model.ts";

export interface MemberDiff {
  name: string;
  /** "here": only in the first party; "there": only in the second. */
  kind: "here" | "there" | "changed" | "same";
  /** For "changed": one line for each field that differs. */
  changes: string[];
}

export interface PartyDiff {
  /** Party-wide lines (day, encumbrance method). */
  party: string[];
  members: MemberDiff[];
}

const SAVES = ["doom", "ray", "hold", "blast", "spell"] as const;

function coins(c: Coins): string {
  const parts = (["pp", "gp", "sp", "cp"] as const).filter((k) => c[k]).map((k) => `${c[k]}${k}`);
  return parts.join(" ") || "none";
}

const itemLine = (i: InvItem): string =>
  `${i.name}${i.qty !== 1 ? ` ×${i.qty}` : ""}${i.where === "equipped" ? "" : ` (${i.where})`}`;

/** The entries of `a` that `b` lacks, counting repeats. */
function only(a: string[], b: string[]): string[] {
  const rest = [...b];
  return a.filter((x) => {
    const i = rest.indexOf(x);
    if (i < 0) return true;
    rest.splice(i, 1);
    return false;
  });
}

const prepared = (p: PC): string[] => p.prepared.map((s) => (s.cast ? `${s.name} (cast)` : s.name));
const runeLines = (p: PC): string[] => p.runes.map((r) => `${r.name} (${r.uses.length} used)`);
const plain = (m: PC): string => JSON.stringify({ ...m, updated: undefined });

/** Lines for a list whose entries are only on one side. */
function listChange(label: string, here: string[], there: string[]): string[] {
  const a = only(here, there);
  const b = only(there, here);
  const out: string[] = [];
  if (a.length) out.push(`${label} only here: ${a.join(", ")}`);
  if (b.length) out.push(`${label} only there: ${b.join(", ")}`);
  return out;
}

/** The fields of one member that differ, as "Label: here → there". */
export function memberChanges(a: PC, b: PC): string[] {
  const out: string[] = [];
  const field = (label: string, x: unknown, y: unknown): void => {
    const sx = String(x ?? "");
    const sy = String(y ?? "");
    if (sx !== sy) out.push(`${label}: ${sx || "—"} → ${sy || "—"}`);
  };
  field("Level", a.level, b.level);
  field("XP", a.xp, b.xp);
  field("HP", `${a.hp}/${a.maxHp}`, `${b.hp}/${b.maxHp}`);
  field("Status", a.status, b.status);
  field("Kindred", a.kindred, b.kindred);
  field("Class", a.class, b.class);
  field("Alignment", a.alignment, b.alignment);
  field("Player", a.player, b.player);
  field("AC bonus", a.acBonus, b.acBonus);
  field("Attack", a.attack, b.attack);
  for (const k of ABILITIES) field(k.toUpperCase(), a.scores[k], b.scores[k]);
  for (const k of SAVES) field(`${k[0].toUpperCase()}${k.slice(1)} save`, a.saves[k], b.saves[k]);
  field("Coins", coins(a.coins), coins(b.coins));
  field("Banked", coins(a.banked), coins(b.banked));
  out.push(...listChange("Gear", a.items.map(itemLine), b.items.map(itemLine)));
  out.push(...listChange("Spells", a.spells, b.spells));
  out.push(...listChange("Prepared", prepared(a), prepared(b)));
  out.push(...listChange("Glamours", a.glamours, b.glamours));
  out.push(...listChange("Knacks", a.knacks, b.knacks));
  out.push(...listChange("Runes", runeLines(a), runeLines(b)));
  out.push(...listChange("Languages", a.languages, b.languages));
  out.push(...listChange("Notes", a.notes, b.notes));
  if (out.length === 0) {
    if (plain(a) !== plain(b)) out.push("Other details differ");
  }
  return out;
}

/** What differs between party `a` (here) and party `b` (there). */
export function partyDiff(a: Party, b: Party): PartyDiff {
  const party: string[] = [];
  if (a.day !== b.day) party.push(`Day: ${a.day} → ${b.day}`);
  if (a.encumbrance !== b.encumbrance)
    party.push(`Encumbrance: ${a.encumbrance} → ${b.encumbrance}`);
  const theirs = new Map(b.members.map((m) => [m.name, m]));
  const members: MemberDiff[] = a.members.map((m) => {
    const other = theirs.get(m.name);
    if (!other) return { name: m.name, kind: "here", changes: [] };
    theirs.delete(m.name);
    const changes = memberChanges(m, other);
    return { name: m.name, kind: changes.length ? "changed" : "same", changes };
  });
  for (const m of theirs.values()) members.push({ name: m.name, kind: "there", changes: [] });
  return { party, members };
}
