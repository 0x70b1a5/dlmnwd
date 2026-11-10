// Spells for the day: which spells a member can make ready, how many of each
// Rank their class gives at their level, and which are cast. Pure: no Node APIs.

import { matchName } from "./actions.ts";
import type { PC, PreparedSpell } from "./model.ts";
import { classOf, type PartyRules, type SpellRef } from "./rules.ts";

/** The spells per day for each Rank (index 0 is Rank 1), or null when the
 *  class has no table or the table has no row for the level. */
export function spellSlots(pc: PC, rules: PartyRules): number[] | null {
  return classOf(rules, pc.class)?.spellsPerDay?.[pc.level - 1] ?? null;
}

/** True when the class casts spells at some level. */
export function isCaster(pc: PC, rules: PartyRules): boolean {
  return (classOf(rules, pc.class)?.spellsPerDay?.length ?? 0) > 0;
}

/**
 * The tradition a class casts from: the one its ability text names most often
 * (as "<tradition> spell"). The traditions come from the book's spells.
 */
export function classTradition(pc: PC, rules: PartyRules): string | null {
  const klass = classOf(rules, pc.class);
  if (!klass?.spellsPerDay) return null;
  const text = klass.traits.map((t) => `${t.name} ${t.text}`).join(" ");
  const traditions = [...new Set(rules.spells.flatMap((s) => s.tradition ?? []))];
  let best: string | null = null;
  let most = 0;
  for (const t of traditions) {
    const n = text.match(new RegExp(`\\b${t}\\s+spells?\\b`, "gi"))?.length ?? 0;
    if (n > most) [best, most] = [t, n];
  }
  return best;
}

function refOf(rules: PartyRules, name: string): SpellRef | undefined {
  return rules.spells.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/** True when the class keeps its spells in spell books and so must learn each one. */
export function learnsSpells(pc: PC, rules: PartyRules): boolean {
  return (classOf(rules, pc.class)?.spellBooks.length ?? 0) > 0;
}

/** The book's spells of the class's tradition: what the member can learn. */
export function traditionSpells(pc: PC, rules: PartyRules): SpellRef[] {
  const tradition = classTradition(pc, rules);
  return tradition ? rules.spells.filter((s) => s.tradition === tradition) : [];
}

/**
 * The spells the member can make ready now. A class with spell books takes
 * from the spells the member knows. Any other caster takes from its tradition.
 * Only Ranks with a slot at this level are given, when the slots are known.
 */
export function preparable(pc: PC, rules: PartyRules): SpellRef[] {
  const slots = spellSlots(pc, rules);
  const pool: SpellRef[] =
    learnsSpells(pc, rules) || pc.spells.length > 0
      ? pc.spells.map((name) => refOf(rules, name) ?? { name, tradition: null, rank: null })
      : traditionSpells(pc, rules);
  return pool.filter((s) => !slots || s.rank === null || (slots[s.rank - 1] ?? 0) > 0);
}

export interface RankUse {
  rank: number;
  slots: number;
  /** Slots filled with a spell, cast or not. */
  filled: number;
  /** Spells ready and not yet cast. */
  ready: number;
}

/** The slots of each Rank the member has at this level, and their use. */
export function slotUse(pc: PC, rules: PartyRules): RankUse[] {
  const slots = spellSlots(pc, rules) ?? [];
  return slots
    .map((n, i): RankUse => {
      const mine = pc.prepared.filter((p) => refOf(rules, p.name)?.rank === i + 1);
      return {
        rank: i + 1,
        slots: n,
        filled: mine.length,
        ready: mine.filter((p) => !p.cast).length,
      };
    })
    .filter((u) => u.slots > 0 || u.filled > 0);
}

/**
 * Make a spell ready. It fills one slot of its Rank. `force` allows a spell the
 * member cannot usually take, or a slot the class does not give. Returns the name.
 */
export function prepareSpell(pc: PC, rules: PartyRules, name: string, force = false): string {
  const q = name.trim();
  if (!q) throw new Error("Name the spell to prepare.");
  const pool = preparable(pc, rules);
  let hit = matchName(
    pool.map((s) => s.name),
    q,
  );
  if (!hit) {
    if (!force) {
      const known = matchName(
        rules.spells.map((s) => s.name),
        q,
      );
      throw new Error(
        known
          ? `${pc.name} can't prepare ${known} now (not known, or no slot of its Rank).`
          : `${pc.name} has no spell matching "${name}" to prepare.`,
      );
    }
    hit =
      matchName(
        rules.spells.map((s) => s.name),
        q,
      ) ?? q;
  }
  const rank = refOf(rules, hit)?.rank ?? null;
  const slots = spellSlots(pc, rules);
  if (slots && rank !== null && !force) {
    const use = slotUse(pc, rules).find((u) => u.rank === rank);
    const max = slots[rank - 1] ?? 0;
    if ((use?.filled ?? 0) >= max)
      throw new Error(
        `${pc.name} has no Rank ${rank} slot free (${max} at level ${pc.level}). Clear one first.`,
      );
  }
  pc.prepared.push({ name: hit, cast: false });
  return hit;
}

function findPrepared(pc: PC, name: string, want: (p: PreparedSpell) => boolean): PreparedSpell {
  const q = name.trim().toLowerCase();
  const all = pc.prepared.filter((p) => q && p.name.toLowerCase().includes(q));
  const exact = all.filter((p) => p.name.toLowerCase() === q);
  const hits = exact.length > 0 ? exact : all;
  if (hits.length === 0) throw new Error(`${pc.name} has no prepared spell matching "${name}".`);
  return hits.find(want) ?? hits[0];
}

/** Cast a prepared spell: its slot is spent until the next rest. Returns the name. */
export function castSpell(pc: PC, name: string): string {
  const hit = findPrepared(pc, name, (p) => !p.cast);
  if (hit.cast) throw new Error(`${pc.name} has already cast ${hit.name} today.`);
  hit.cast = true;
  return hit.name;
}

/** Take a spell out of its slot (a cast one first). Returns the name. */
export function clearSpell(pc: PC, name: string): string {
  const hit = findPrepared(pc, name, (p) => p.cast);
  pc.prepared.splice(pc.prepared.indexOf(hit), 1);
  return hit.name;
}

/** One line for a text sheet: "Rank 1 1/2 ready · Rank 2 0/1 ready". */
export function slotLine(pc: PC, rules: PartyRules): string {
  return slotUse(pc, rules)
    .map((u) => `Rank ${u.rank} ${u.ready}/${u.slots} ready`)
    .join(" · ");
}
