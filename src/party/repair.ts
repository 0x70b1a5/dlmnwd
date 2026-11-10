// Fill the numbers a class table gives when a member's file had none. A party
// file written by hand, or a sheet with empty save boxes, gives Save Targets of
// 0, which no table has. Pure: no Node APIs.

import type { Party, PC, Saves } from "./model.ts";
import { classOf, type PartyRules } from "./rules.ts";
import { currentRow } from "./xp.ts";

const SAVE_KEYS: (keyof Saves)[] = ["doom", "ray", "hold", "blast", "spell"];

/** True when no Save Target is set. A real target is never 0. */
export function savesMissing(pc: PC): boolean {
  return SAVE_KEYS.every((k) => !pc.saves[k]);
}

export interface Repair {
  /** True when the Save Targets are now set. */
  filled: boolean;
  /** A plain statement without the member's name. */
  text: string;
}

/**
 * Set a member's missing Save Targets (and an Attack of 0) from their class
 * table. Returns null when the member has Save Targets already.
 */
export function fillFromClass(pc: PC, rules: PartyRules): Repair | null {
  if (!savesMissing(pc)) return null;
  const klass = classOf(rules, pc.class);
  const row = currentRow(pc, klass) ?? (klass && pc.level === 1 ? klass : undefined);
  if (!klass) return { filled: false, text: "no Save Targets, and the class is not known" };
  if (!row)
    return {
      filled: false,
      text: `no Save Targets: the ${klass.name} table has no Level ${pc.level}`,
    };
  pc.saves = { ...row.saves };
  if (pc.attack === 0) pc.attack = row.attack;
  return {
    filled: true,
    text: `Save Targets set from the ${klass.name} table (Level ${pc.level})`,
  };
}

/** fillFromClass for each member. Returns a statement for each member it set. */
export function repairParty(party: Party, rules: PartyRules): string[] {
  return party.members.flatMap((pc) => {
    const fix = fillFromClass(pc, rules);
    return fix?.filled ? [`${pc.name}: ${fix.text}.`] : [];
  });
}
