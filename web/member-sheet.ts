// A party member as sheet data, so the Party tab can show (and print) the full
// sheet of anyone in the party, not only a fresh roll. Pure: the details of
// spells, glamours and knacks come from the saved book when there is one.

import { coinCount, computeAc, describeLoad } from "../src/party/encumbrance.ts";
import type { InvItem, Party, PC } from "../src/party/model.ts";
import { formatCoins, loadOf } from "../src/party/render.ts";
import { classOf, kindredOf, type PartyRules } from "../src/party/rules.ts";
import { runeStatus } from "../src/party/runes.ts";
import { nextLevelXp } from "../src/party/xp.ts";
import { type Book, spellMap } from "./book.ts";
import { personaRows, physiqueRows, type SheetData } from "./sheet.ts";

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

function itemRow(i: InvItem, method: Party["encumbrance"]): [string, string] {
  const name = `${i.name}${i.qty !== 1 ? ` ×${i.qty}` : ""}${i.note ? ` (${i.note})` : ""}`;
  const stowed = i.where === "stowed" ? "stowed" : "";
  if (method === "basic") return [name, stowed || "equipped"];
  const n = method === "slots" ? i.qty * i.slots : i.qty * i.weight;
  return [name, [String(n), stowed].filter((x) => x).join(", ")];
}

const GEAR_HEAD: Record<Party["encumbrance"], [string, string]> = {
  weight: ["Item", "Coins"],
  slots: ["Item", "Slots"],
  basic: ["Item", "Carried"],
};

/** The sheet data for a party member, as they are now. */
export function memberSheet(pc: PC, party: Party, rules: PartyRules, book: Book | null): SheetData {
  const kindred = kindredOf(rules, pc.kindred);
  const klass = classOf(rules, pc.class);
  const kindredName = kindred?.name ?? pc.kindred;
  const className = klass?.name ?? pc.class;
  const load = loadOf(pc, party, rules);
  const next = nextLevelXp(pc, klass);

  const gear: [string, string][] = [
    ...pc.items.filter((i) => i.where === "equipped").map((i) => itemRow(i, party.encumbrance)),
    ...pc.items.filter((i) => i.where === "stowed").map((i) => itemRow(i, party.encumbrance)),
    ["Coins", formatCoins(pc.coins)],
  ];
  if (coinCount(pc.banked) > 0) gear.push(["Banked", formatCoins(pc.banked)]);
  gear.push(["Load", describeLoad(load)]);
  for (const p of load.problems) gear.push(["Problem", p]);

  const spells = book ? spellMap(book) : new Map();
  const glamours = new Map(book?.glamourDetails ?? []);
  const knacks = book?.knacks ?? [];

  const extras: [string, string][] = [];
  if (pc.player) extras.push(["Player", pc.player]);
  if (pc.moonSign) extras.push(["Moon sign", pc.moonSign]);
  if (pc.affiliation) extras.push(["Affiliation", pc.affiliation]);

  return {
    name: pc.name,
    badges: [
      `Level ${pc.level}`,
      kindredName,
      className,
      pc.alignment,
      pc.background,
      pc.retainer ? "Retainer" : "",
      pc.status !== "active" ? pc.status[0].toUpperCase() + pc.status.slice(1) : "",
    ].filter((b) => b),
    stats: [
      ["Hit Points", `${pc.hp}/${pc.maxHp}`],
      ["Armour Class", String(computeAc(pc, rules.catalog))],
      ["Attack", signed(pc.attack)],
      ["Speed", String(load.speed)],
      ["Gold", pc.coins.gp.toLocaleString()],
      next !== null
        ? [`XP to L${pc.level + 1}`, `${pc.xp.toLocaleString()}/${next.toLocaleString()}`]
        : ["XP", pc.xp.toLocaleString()],
    ],
    scores: pc.scores,
    prime: klass?.primeAbilities ?? [],
    saves: pc.saves,
    magicResistance: pc.magicResistance,
    skills: pc.skills,
    languages: pc.languages,
    extraLanguages: 0,
    gear: { head: GEAR_HEAD[party.encumbrance], rows: gear },
    physique: physiqueRows(pc.physique, pc.persona),
    persona: [...extras, ...personaRows(pc.persona)],
    kindredTraits: { title: `${kindredName} Abilities`, traits: kindred?.traits ?? [] },
    classTraits: { title: `${className} Abilities`, traits: klass?.traits ?? [] },
    // The spells known, then any spell in a slot that is not one of them.
    spells: [...new Set([...pc.spells, ...pc.prepared.map((p) => p.name)])].map(
      (name) =>
        spells.get(name.toLowerCase()) ?? {
          name,
          tradition: null,
          rank: null,
          duration: null,
          range: null,
          body: null,
        },
    ),
    glamours: pc.glamours.map(
      (name) =>
        glamours.get(name.toLowerCase()) ?? { name, duration: null, range: null, body: null },
    ),
    knacks: pc.knacks.map(
      (name) =>
        knacks.find((k) => k.name.toLowerCase() === name.toLowerCase()) ?? { name, text: "" },
    ),
    runes: pc.runes.map((r) => {
      // How often it may be used now, then what it does (the book's entry).
      const st = runeStatus(r, pc, party.day, rules.runes);
      // Exact name only: a near match would show another rune's text.
      const entry = rules.runes.runes.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
      const times = r.times > 1 ? ` ×${r.times}` : "";
      const left = st.left === null ? "" : ` ${st.left} of ${st.limit} left.`;
      const usage = st.band ? `${st.band.text}${times}.${left}` : "";
      return {
        name: r.name,
        tag: r.magnitude || null,
        duration: entry?.duration ?? null,
        range: entry?.range ?? null,
        text: [usage, entry?.body].filter((t) => t).join("\n"),
      };
    }),
    notes: pc.notes,
  };
}
