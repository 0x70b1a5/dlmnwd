// Rendering for the character sheet, shared by the live app (main.ts) and the
// prefilled mock page (mock.ts). Pure DOM building; no parsing or file I/O.

import {
  APPEARANCE_FIELDS,
  type Character,
  PERSONA_ORDER,
  resolvedKindredTraits,
} from "../src/gen/character.ts";
import { parseStatBlock, structureTrait } from "../src/parse/traits.ts";
import { abilityMod } from "../src/rules.ts";

const ABILITIES = ["str", "int", "wis", "dex", "con", "cha"] as const;

/** Text as the sheet shows it. A no-break space becomes a plain one, so long
 *  lines wrap; the book's own quotes and dashes stay. */
export function clean(s: string): string {
  return s.replace(/\u00A0/g, " ");
}

// ── tiny DOM builder ──────────────────────────────────────────────────────
type Child = Node | string | null | undefined | false;
export function h(tag: string, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(typeof kid === "string" ? document.createTextNode(clean(kid)) : kid);
  }
  return node;
}
const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

// A badge: a label with an optional emphasised value.
export function badge(label: string, value?: string, variant?: "accent" | "soft"): HTMLElement {
  return h(
    "span",
    { class: variant ? `badge badge--${variant}` : "badge" },
    label,
    value !== undefined ? h("span", { class: "bv" }, value) : null,
  );
}

function section(title: string, body: HTMLElement, span = 12): HTMLElement {
  return h("section", { class: `section span-${span}` }, title ? h("h3", {}, title) : null, body);
}

const ABILITY_LABEL: Record<string, string> = {
  str: "Strength",
  int: "Intelligence",
  wis: "Wisdom",
  dex: "Dexterity",
  con: "Constitution",
  cha: "Charisma",
};

function table(head: string[], rows: HTMLElement[], numeric: boolean[]): HTMLElement {
  const thead = h(
    "thead",
    {},
    h("tr", {}, ...head.map((label, i) => h("th", numeric[i] ? { class: "num" } : {}, label))),
  );
  return h("table", {}, thead, h("tbody", {}, ...rows));
}

// Abilities stacked vertically (one row per ability) for easy parsing.
function abilitiesSection(c: SheetData): HTMLElement {
  const prime = new Set(c.prime);
  const rows = ABILITIES.map((a) =>
    h(
      "tr",
      {},
      h(
        "td",
        {},
        ABILITY_LABEL[a],
        prime.has(a)
          ? h("span", { class: "field-label", style: "margin-left:.45rem" }, "prime")
          : null,
      ),
      h("td", { class: "num" }, String(c.scores[a])),
      h("td", { class: "num" }, signed(abilityMod(c.scores[a]))),
    ),
  );
  return section("", table(["Abilities", "Score", "Mod"], rows, [false, true, true]), 4);
}

// Saving throws stacked vertically, one per row.
function savesSection(c: SheetData): HTMLElement {
  const s = c.saves;
  const mr = c.magicResistance > 0 ? `+${c.magicResistance}` : "0";
  const items: [string, string][] = [
    ["Doom", String(s.doom)],
    ["Ray", String(s.ray)],
    ["Hold", String(s.hold)],
    ["Blast", String(s.blast)],
    ["Spell", String(s.spell)],
    ["Magic Resistance", mr],
  ];
  const rows = items.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", { class: "num" }, v)));
  return section("", table(["Saving Throws", "Target"], rows, [false, true]), 4);
}

// Skill targets as wrapping chips. Listen/Search/Survival lead, then the rest.
const SKILL_ORDER = ["Listen", "Search", "Survival"];
/** One badge per skill target. */
export function skillBadges(skills: Record<string, number>): HTMLElement[] {
  const rank = (n: string): number => {
    const i = SKILL_ORDER.indexOf(n);
    return i < 0 ? SKILL_ORDER.length : i;
  };
  const entries = Object.entries(skills).toSorted(
    (a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]),
  );
  return entries.map(([k, v]) => badge(k, String(v)));
}
function skillsSection(c: SheetData): HTMLElement {
  return section("Skill Targets", h("div", { class: "chips" }, ...skillBadges(c.skills)), 4);
}

function subPoint(s: { kind: string; label?: string; body: string }): HTMLElement {
  if (s.kind === "statblock") {
    const sb = parseStatBlock(s.body);
    if (sb) {
      return h(
        "span",
        { class: "trait-sub statblock" },
        sb.typeLine ? h("span", { class: "sb-type" }, sb.typeLine) : null,
        h(
          "span",
          { class: "sb-stats" },
          ...sb.stats.map((st) =>
            h(
              "span",
              { class: "sb-stat" },
              h("span", { class: "field-label" }, st.label),
              ` ${st.value}`,
            ),
          ),
        ),
      );
    }
  }
  const cls = s.kind === "item" ? "trait-sub trait-item" : "trait-sub";
  return h(
    "span",
    { class: cls },
    s.label ? h("span", { class: "sub-label" }, `${s.label}:`) : null,
    s.label ? ` ${s.body}` : s.body,
  );
}

// One trait: bold name + lead sentence, then structured sub-points indented
// under it. A named sub-heading opens a further-indented group — giving three
// visible levels: name, sub-heading, run-in label.
export function traitParagraph(t: { name: string; text: string }): HTMLElement {
  const { lead, subs } = structureTrait(t.text);
  const p = h("p", { class: "trait" }, h("span", { class: "tn" }, `${t.name}. `), lead);
  if (subs.length === 0) return p;
  // All sub-points sit in an indented body so they read as part of this trait.
  const body = h("span", { class: "trait-body" });
  p.append(body);
  let group = body;
  for (const s of subs) {
    if (s.kind === "subhead") {
      body.append(h("span", { class: "trait-subhead" }, s.body));
      group = h("span", { class: "trait-nest" });
      body.append(group);
    } else {
      group.append(subPoint(s));
    }
  }
  return p;
}

// One abilities block (kindred or class), name and description, two-column flow.
// The section is titled by the group ("<Kindred> Abilities"), so no separate
// "Kindred & Class Traits" header is needed — the source is self-evident.
function traitSection(title: string, traits: SheetTrait[]): HTMLElement | null {
  if (traits.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const t of traits) list.append(traitParagraph(t));
  return section(title, list);
}

function languagesSection(c: SheetData): HTMLElement {
  const langBadges = c.languages.map((l) => badge(l));
  if (c.extraLanguages > 0)
    langBadges.push(badge(`+${c.extraLanguages} of choice`, undefined, "soft"));
  const body = langBadges.length
    ? h("div", { class: "chips" }, ...langBadges)
    : h("p", { class: "hint", style: "margin:0" }, "None");
  return section("Languages", body, 4);
}

// Equipment as a tall vertical table — roughly double the height of the
// abilities/saves tables, since a starting character carries many items.
function gearSection(c: SheetData): HTMLElement {
  const rows = c.gear.rows.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, v)));
  return section("", table(c.gear.head, rows, [false, false]), 4);
}

/** A generated character's starting gear, as sheet rows. */
function characterGear(c: Character): [string, string][] {
  const rows: [string, string][] = [];
  // Loadout.
  rows.push(["Armour", `${c.loadout.armour} (AC ${c.loadout.baseAc})`]);
  for (const w of c.weapons) rows.push(["Weapon", w]);
  for (const item of c.classItems) rows.push(["Class item", item]);
  rows.push(["Gold", `${c.gold} gp`]);
  // General starting gear, then adventuring items.
  for (const g of c.generalItems) rows.push(["Gear", g]);
  for (const g of c.adventuringItems) rows.push(["Item", g]);
  // Spell book — name only; the spell list and details live in the Magic section.
  if (c.spellBook) rows.push(["Spell book", c.spellBook.name]);
  // Trinket lives in the persona section, not here.
  return rows;
}

function kvSection(title: string, rows: [string, string][]): HTMLElement | null {
  const present = rows.filter(([, v]) => v);
  if (present.length === 0) return null;
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of present) dl.append(h("div", {}, h("dt", {}, k), h("dd", {}, v)));
  return section(title, dl, 4);
}

/** Physique: rolled body stats plus the appearance persona fields. A field
 *  with no value stays as a blank line to fill in. */
export function physiqueRows(
  physique: Partial<Record<string, string>> | undefined,
  persona: Record<string, string>,
): [string, string][] {
  return [
    ["Age", physique?.age ?? ""],
    ["Height", physique?.height ?? ""],
    ["Weight", physique?.weight ?? ""],
    ["Lifespan", physique?.lifespan ?? ""],
    ...APPEARANCE_FIELDS.map((f): [string, string] => [f, persona[f] ?? ""]),
  ];
}

// Persona: manner and inner life (appearance lives in Physique). Ordered for a
// consistent read; anything unlisted keeps its parsed order at the end.
function personaRank(f: string): number {
  const i = PERSONA_ORDER.indexOf(f.toLowerCase());
  return i < 0 ? PERSONA_ORDER.length : i;
}

/** Persona fields in reading order, appearance left out, the trinket last. */
export function personaRows(persona: Record<string, string>, trinket?: string): [string, string][] {
  const rows = Object.entries(persona)
    .filter(([f]) => !APPEARANCE_FIELDS.includes(f))
    .toSorted((a, b) => personaRank(a[0]) - personaRank(b[0]));
  if (trinket) rows.push(["Trinket", trinket]);
  return rows;
}

function personaSection(c: SheetData): HTMLElement | null {
  if (c.persona.length === 0) return null;
  const dl = h("dl", { class: "kv" });
  for (const [field, value] of c.persona)
    dl.append(h("div", {}, h("dt", {}, field), h("dd", {}, value)));
  return section("Persona", dl, 4);
}

/** The blank canvas shown before a character is generated. */
export function renderEmpty(sheet: HTMLElement): void {
  sheet.dataset.state = "empty";
  sheet.classList.remove("reveal");
  sheet.replaceChildren(
    h(
      "div",
      { class: "empty" },
      h("div", { class: "glyph" }, "[ ? ]"),
      h("p", { class: "say" }, "No character yet"),
      h(
        "p",
        { class: "sub" },
        "Choose your Player's Book, pick a kindred and class, then Generate.",
      ),
    ),
  );
}

// One casting entry (spell or glamour), shaped like a trait: bold name, an
// optional uppercase tag, a Duration/Range stat line, then body prose. Every
// size here comes from the sheet's existing three type tokens (trait body,
// trait-group header, field-label) so the block reads as one hierarchy.
export function castingEntry(
  name: string,
  tag: string | null,
  duration: string | null,
  range: string | null,
  body: string | null,
): HTMLElement {
  const stat =
    duration || range
      ? h(
          "span",
          { class: "cast-stat" },
          duration ? h("span", { class: "field-label" }, "Duration") : null,
          duration ? `${duration} ` : null,
          range ? h("span", { class: "field-label" }, "Range") : null,
          range ? range : null,
        )
      : null;
  return h(
    "p",
    { class: "trait cast" },
    h("span", { class: "tn" }, `${name} `),
    tag ? h("span", { class: "cast-tag" }, tag) : null,
    stat,
    body ? h("span", { class: "cast-body" }, body) : null,
  );
}

// Magician's known spells, each with its tradition/rank tag and stat line.
function spellsSection(c: SheetData): HTMLElement | null {
  const spells = c.spells;
  if (spells.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const spell of spells) {
    const tag = [spell.tradition, spell.rank ? `Rank ${spell.rank}` : ""].filter(Boolean).join(" ");
    list.append(castingEntry(spell.name, tag || null, spell.duration, spell.range, spell.body));
  }
  return section("Spells", list);
}

// Rolled glamours (enchanters, elves, grimalkins). No tradition tag.
function glamoursSection(c: SheetData): HTMLElement | null {
  const glamours = c.glamours;
  if (glamours.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const g of glamours) {
    list.append(castingEntry(g.name, null, g.duration, g.range, g.body));
  }
  return section("Glamours", list);
}

// Knacks (mosslings): level-gated abilities, so rendered like a trait.
function knacksSection(c: SheetData): HTMLElement | null {
  const knacks = c.knacks;
  if (knacks.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const k of knacks) list.append(traitParagraph(k));
  return section("Knacks", list);
}

// Runes (a party member's): name, magnitude tag, then how often it may be used.
function runesSection(c: SheetData): HTMLElement | null {
  if (c.runes.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const r of c.runes)
    list.append(castingEntry(r.name, r.tag, r.duration, r.range, r.text || null));
  return section("Runes", list);
}

function notesSection(c: SheetData): HTMLElement | null {
  if (c.notes.length === 0) return null;
  const list = h("div", { class: "trait-list" });
  for (const n of c.notes) list.append(h("p", { class: "trait" }, n));
  return section("Notes", list);
}

export interface SheetTrait {
  name: string;
  text: string;
}

/** Everything the sheet shows, from a generated character or a party member. */
export interface SheetData {
  name: string;
  /** Under the name: level, kindred, class, alignment, background. */
  badges: string[];
  /** The headline stat line: [label, value], six of them. */
  stats: [string, string][];
  scores: Record<(typeof ABILITIES)[number], number>;
  prime: string[];
  saves: { doom: number; ray: number; hold: number; blast: number; spell: number };
  magicResistance: number;
  skills: Record<string, number>;
  languages: string[];
  extraLanguages: number;
  gear: { head: [string, string]; rows: [string, string][] };
  physique: [string, string][];
  persona: [string, string][];
  kindredTraits: { title: string; traits: SheetTrait[] };
  classTraits: { title: string; traits: SheetTrait[] };
  spells: {
    name: string;
    tradition: string | null;
    rank: number | null;
    duration: string | null;
    range: string | null;
    body: string | null;
  }[];
  glamours: { name: string; duration: string | null; range: string | null; body: string | null }[];
  knacks: SheetTrait[];
  runes: {
    name: string;
    tag: string | null;
    duration: string | null;
    range: string | null;
    text: string;
  }[];
  notes: string[];
}

/** The sheet data for a freshly generated level-1 character. */
export function characterSheet(c: Character): SheetData {
  return {
    name: c.name,
    badges: [
      "Level 1",
      c.kindred.name,
      c.klass.name,
      c.alignment,
      ...(c.background ? [c.background] : []),
    ],
    stats: [
      ["Hit Points", String(c.hp)],
      ["Armour Class", String(c.loadout.ac)],
      ["Attack", signed(c.klass.attack)],
      ["Speed", String(c.speed)],
      ["Gold", String(c.gold)],
      ["XP to L2", c.klass.nextLevelXp.toLocaleString()],
    ],
    scores: c.scores,
    prime: c.klass.primeAbilities,
    saves: c.klass.saves,
    magicResistance: c.magicResistance,
    skills: c.skills,
    languages: c.languages,
    extraLanguages: c.extraLanguages,
    gear: { head: ["Item", "Detail"], rows: characterGear(c) },
    physique: physiqueRows(c.physique, c.persona),
    persona: personaRows(c.persona, c.trinket ?? undefined),
    kindredTraits: { title: `${c.kindred.name} Abilities`, traits: resolvedKindredTraits(c) },
    classTraits: { title: `${c.klass.name} Abilities`, traits: c.klass.traits },
    spells: c.magic.spells,
    glamours: c.magic.glamours,
    knacks: c.magic.knacks,
    runes: [],
    notes: [],
  };
}

/** Render a generated character's sheet. */
export function renderSheet(sheet: HTMLElement, c: Character): void {
  renderSheetData(sheet, characterSheet(c));
}

/** The sheet's parts, top to bottom. */
interface SheetParts {
  head: HTMLElement;
  statline: HTMLElement;
  grid: HTMLElement;
  abilityFlow: HTMLElement;
}

function sheetParts(c: SheetData): SheetParts {
  const meta = h("div", { class: "sheet-sub-row" }, ...c.badges.map((b) => badge(b)));
  const head = h(
    "div",
    { class: "sheet-head" },
    h("div", {}, h("h2", { class: "sheet-name" }, c.name), meta),
  );
  const statline = h(
    "dl",
    { class: "statline" },
    ...c.stats.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))),
  );
  // Three columns: abilities + skills/languages/persona stacked on the left,
  // saves in the middle, equipment on the right. Traits span full width below.
  const stack = (...secs: (HTMLElement | null)[]): HTMLElement =>
    h("div", { class: "stack span-4" }, ...secs.filter((n): n is HTMLElement => n !== null));
  const kindredTraits = traitSection(c.kindredTraits.title, c.kindredTraits.traits);
  const classTraits = traitSection(c.classTraits.title, c.classTraits.traits);
  const grid = h(
    "div",
    { class: "sheet-grid" },
    // Physique (tall) sits under the left stack, Languages (short) under the
    // middle, so the two columns balance beside the tall Persona.
    stack(abilitiesSection(c), skillsSection(c), kvSection("Physique", c.physique)),
    stack(savesSection(c), languagesSection(c), personaSection(c)),
    gearSection(c),
  );
  // The prose sections (abilities, spells, glamours, knacks) flow as one block.
  // On screen each keeps its own two-column trait list; in print the whole block
  // becomes a single newspaper flow (down one column, then the next).
  const abilityFlow = h(
    "div",
    { class: "ability-flow" },
    ...[
      kindredTraits,
      classTraits,
      spellsSection(c),
      glamoursSection(c),
      knacksSection(c),
      runesSection(c),
      notesSection(c),
    ].filter((n): n is HTMLElement => n !== null),
  );
  return { head, statline, grid, abilityFlow };
}

/** Render the full sheet, filling in (with a staggered reveal) on each call
 *  unless `reveal` is false. */
export function renderSheetData(
  sheet: HTMLElement,
  c: SheetData,
  { reveal = true }: { reveal?: boolean } = {},
): void {
  const { head, statline, grid, abilityFlow } = sheetParts(c);
  const blocks = [head, statline, grid, abilityFlow];
  blocks.forEach((node, i) => node.style.setProperty("--i", String(i)));
  sheet.dataset.state = "full";
  sheet.replaceChildren(...blocks);
  // Restart the reveal animation on each generate.
  sheet.classList.remove("reveal");
  if (!reveal) return;
  void sheet.offsetWidth;
  sheet.classList.add("reveal");
}
