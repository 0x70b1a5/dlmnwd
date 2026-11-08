// Changes to a party member that the CLI (commands/pc.ts) and the web app both
// make. Each one changes the PC in place and throws an Error with a message for
// the user when it can't. Pure: no Node APIs, no printing.

import { pick } from "../util.ts";
import {
  ABILITIES,
  type Ability,
  type CoinKind,
  type Coins,
  type KnownRune,
  type PC,
} from "./model.ts";
import { classOf, kindredOf, type PartyRules } from "./rules.ts";

export type NameList = "glamours" | "knacks" | "spells";

/** Read "120gp" as a coin kind and count. */
export function coinSpec(spec: string): { kind: CoinKind; n: number } {
  const m = spec.match(/^(\d+)\s*(cp|sp|gp|pp)$/i);
  if (!m) throw new Error(`Can't read "${spec}" as coins (e.g. 120gp, 5sp).`);
  return { kind: m[2].toLowerCase() as CoinKind, n: parseInt(m[1], 10) };
}

/** Apply "+120gp", "-5sp" or "=0cp" to a purse. */
export function applyCoins(c: Coins, spec: string): void {
  const m = spec.match(/^([+=-]?)(\d+)\s*(cp|sp|gp|pp)$/i);
  if (!m) throw new Error(`Can't read "${spec}" as coins (e.g. +120gp, -5sp, =0cp).`);
  const kind = m[3].toLowerCase() as CoinKind;
  const n = parseInt(m[2], 10);
  if (m[1] === "=") c[kind] = n;
  else if (m[1] === "-") {
    if (c[kind] < n) throw new Error(`Only ${c[kind]}${kind} to spend.`);
    c[kind] -= n;
  } else c[kind] += n;
}

/** Move coins between two purses (carried and banked). */
export function moveCoins(from: Coins, to: Coins, kind: CoinKind, n: number, who: string): void {
  if (!(n > 0)) return;
  if (from[kind] < n) throw new Error(`${who} has only ${from[kind]}${kind} to move.`);
  from[kind] -= n;
  to[kind] += n;
}

/** Apply "-4" (damage), "+3" (heal), "=7" (set) or "max" to the PC's HP. */
export function applyHp(pc: PC, spec: string): void {
  if (spec === "max" || spec === "full") pc.hp = pc.maxHp;
  else if (/^=-?\d+$/.test(spec)) pc.hp = parseInt(spec.slice(1), 10);
  else if (/^[+-]\d+$/.test(spec)) pc.hp += parseInt(spec, 10);
  else throw new Error("HP takes -N (damage), +N (heal), =N (set) or max.");
  pc.hp = Math.min(pc.hp, pc.maxHp);
}

/** The book's name for a query: exact, then prefix, then substring (case-insensitive). */
export function matchName(known: string[], query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    known.find((k) => k.toLowerCase() === q) ??
    known.find((k) => k.toLowerCase().startsWith(q)) ??
    known.find((k) => k.toLowerCase().includes(q))
  );
}

/**
 * Add a glamour, knack or spell. `known` is the book's list: the name is matched
 * to it, and a name not in it needs `force`. `random` picks one not yet known.
 * Returns the name added.
 */
export function learnName(
  pc: PC,
  field: NameList,
  known: string[],
  name: string,
  opts: { random?: boolean; force?: boolean } = {},
): string {
  const list = pc[field];
  const has = (n: string) => list.some((l) => l.toLowerCase() === n.toLowerCase());
  let chosen = name.trim();
  if (opts.random) {
    const pool = known.filter((k) => !has(k));
    if (pool.length === 0) throw new Error(`No unknown ${field} left to roll (or none indexed).`);
    chosen = pick(pool);
  } else {
    if (!chosen) throw new Error(`Name the ${field.replace(/s$/, "")} to add.`);
    const hit = matchName(known, chosen);
    if (hit) chosen = hit;
    else if (known.length > 0 && !opts.force)
      throw new Error(`"${name}" isn't one of the book's ${field}; --force to add it anyway.`);
  }
  if (has(chosen)) throw new Error(`${pc.name} already knows ${chosen}.`);
  list.push(chosen);
  return chosen;
}

/** Remove a glamour, knack or spell by any part of its name. Returns the name removed. */
export function forgetName(pc: PC, field: NameList, name: string): string {
  const q = name.trim().toLowerCase();
  const list = pc[field];
  const hit =
    list.find((l) => l.toLowerCase() === q) ?? list.find((l) => l.toLowerCase().includes(q));
  if (!q || !hit)
    throw new Error(`${pc.name} doesn't know a ${field.replace(/s$/, "")} matching "${name}".`);
  pc[field] = list.filter((l) => l !== hit);
  return hit;
}

/** The class's count for a name list at the PC's level (e.g. Glamours: "2"), if any. */
export function allowedCount(pc: PC, rules: PartyRules, field: NameList): number | null {
  const row = classOf(rules, pc.class)?.advancement?.find((r) => r.level === pc.level);
  const v = row?.extras[field.charAt(0).toUpperCase() + field.slice(1)];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A known rune by any part of its name: exact first. */
export function findRune(pc: PC, name: string): KnownRune {
  const q = name.trim().toLowerCase();
  const hit =
    pc.runes.find((r) => r.name.toLowerCase() === q) ??
    pc.runes.find((r) => r.name.toLowerCase().includes(q));
  if (!q || !hit) throw new Error(`${pc.name} doesn't know a rune matching "${name}".`);
  return hit;
}

/** Does the class (or a kindred trait) grant a rune chance on each new level? */
export function gainsRunesOnLevel(pc: PC, rules: PartyRules): boolean {
  if (classOf(rules, pc.class)?.runeOnLevel) return true;
  const traits = kindredOf(rules, pc.kindred)?.traits ?? [];
  return traits.some((t) => /each time the character gains a Level[^.]*\brune/i.test(t.text));
}

function yes(v: string): boolean {
  return /^(y|yes|true|1|on)$/i.test(v);
}

/** Set one field from "key=value" (the names `dw pc <name> set` takes). */
export function setField(pc: PC, rules: PartyRules, kv: string): void {
  const m = kv.match(/^([a-z_]+)=(.*)$/i);
  if (!m) throw new Error(`Expected key=value, got "${kv}".`);
  const [, k, v] = m;
  const key = k.toLowerCase();
  const int = (): number => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`${k} needs a number, not "${v}".`);
    return n;
  };
  if ((ABILITIES as readonly string[]).includes(key)) {
    pc.scores[key as Ability] = int();
    return;
  }
  switch (key) {
    case "name":
    case "player":
    case "alignment":
    case "background":
    case "affiliation":
      pc[key] = v;
      return;
    case "moon_sign":
    case "moonsign":
      pc.moonSign = v;
      return;
    case "kindred": {
      const kin = rules.kindreds.find(
        (x) => x.id === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase(),
      );
      if (!kin && rules.kindreds.length) throw new Error(`Unknown kindred "${v}".`);
      pc.kindred = kin?.id ?? v.toLowerCase();
      return;
    }
    case "class": {
      const c = rules.classes.find(
        (x) => x.id === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase(),
      );
      if (!c && rules.classes.length) throw new Error(`Unknown class "${v}".`);
      pc.class = c?.id ?? v.toLowerCase();
      return;
    }
    case "level": {
      // Setting the level directly re-reads Attack and Saves from the table.
      pc.level = int();
      const row = classOf(rules, pc.class)?.advancement?.find((r) => r.level === pc.level);
      if (row) {
        pc.attack = row.attack;
        pc.saves = { ...row.saves };
      }
      return;
    }
    case "xp":
      pc.xp = Math.max(0, int());
      return;
    case "hp":
      pc.hp = int();
      return;
    case "max_hp":
    case "maxhp":
      pc.maxHp = int();
      return;
    case "ac_bonus":
    case "acbonus":
      pc.acBonus = int();
      return;
    case "attack":
      pc.attack = int();
      return;
    case "mr":
    case "magic_resistance":
      pc.magicResistance = int();
      return;
    case "retainer":
      pc.retainer = yes(v);
      return;
    case "status":
      if (!["active", "retired", "dead"].includes(v))
        throw new Error("status: active|retired|dead");
      pc.status = v as PC["status"];
      return;
    default:
      throw new Error(`Unknown field "${k}".`);
  }
}
