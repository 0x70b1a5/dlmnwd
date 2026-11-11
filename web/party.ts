// The party view: the characters a table is running, and the changes play makes
// to them (XP and levels, HP, gear and encumbrance, coins, runes, glamours,
// knacks, spells, notes). The rules come from the party engine in src/party/,
// the same code `dw party` and `dw pc` run. The party stays in this browser.
//
// A member is laid out by how often each part is used in play. A strip with the
// name, HP, AC, attack, speed and saves stays in view. Then come the abilities
// and skills, XP and gold, what the member can cast, the gear, coins and notes.
// The rules text folds to one line an entry. What a session rarely changes is
// in a closed "Edit character" fold.

import type { Character, SpellDetail } from "../src/gen/character.ts";
import {
  allowedCount,
  applyHp,
  findRune,
  forgetName,
  gainsRunesOnLevel,
  learnName,
  type NameList,
  newDay,
  setField,
} from "../src/party/actions.ts";
import {
  castSpell,
  learnsSpells,
  preparable,
  prepareSpell,
  slotUse,
  traditionSpells,
} from "../src/party/spells.ts";
import { computeAc, describeLoad } from "../src/party/encumbrance.ts";
import { characterToPc } from "../src/party/from-character.ts";
import { type ImportResult, pcFromSheet } from "../src/party/import.ts";
import { readFormFields } from "../src/pdf/fields.ts";
import { addItem, makeItem, removeItem } from "../src/party/items.ts";
import {
  COIN_KINDS,
  ENC_METHODS,
  type EncMethod,
  freshParty,
  normalizeParty,
  type InvItem,
  type Party,
  type PC,
  type Where,
} from "../src/party/model.ts";
import { formatCoins, kindredClass, loadOf, pcMarkdown } from "../src/party/render.ts";
import { classOf, emptyRules, type PartyRules } from "../src/party/rules.ts";
import { grantRune, lookupRune, rollRuneGrant, runeStatus, useRune } from "../src/party/runes.ts";
import {
  awardParty,
  canLevel,
  grantXp,
  levelUp,
  nextLevelXp,
  xpModifier,
} from "../src/party/xp.ts";
import {
  download,
  loadStoredParty,
  partyJson,
  readPartyFile,
  safeName,
  storeParty,
} from "./party-store.ts";
import { abilityMod } from "../src/rules.ts";
import {
  castingEntry,
  h,
  renderSheetData,
  type SheetData,
  skillBadges,
  traitParagraph,
} from "./sheet.ts";
import { repairParty, savesMissing } from "../src/party/repair.ts";
import { morph, on } from "./morph.ts";
import { partyLink } from "./party-link.ts";
import { block, button, form, numInput, select, textInput } from "./ui.ts";

export interface PartyView {
  /** Use the rules from a newly loaded Player's Book. */
  setRules(rules: PartyRules): void;
  /** Add a generated character. Returns the name it was added under. */
  add(character: Character): string;
  /** Select a member by name, for when the view is shown. */
  select(name: string): void;
  /** Offer a party from elsewhere (a link) in place of this one. */
  offer(party: Party, from: string): void;
}

/** A note under the party bar; `details` lists what a change found on the way. */
type Message = { text: string; kind: "info" | "error"; details?: string[] };

/** Chat apps and mail cut links longer than about this. */
const LONG_LINK = 6000;

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface PartyHooks {
  /** Hears the member count after each change. */
  onCount(n: number): void;
  /** A member as sheet data: the rules text to show and the sheet to print. */
  sheet(pc: PC, party: Party, rules: PartyRules): SheetData;
  /** Hears what each change said, to show where every tab can see it. */
  onNote?(text: string, kind: "info" | "error"): void;
  /** A spell's entry in the saved book, for a spell the member can prepare. */
  spell?(name: string): SpellDetail | undefined;
}

/** Show the party in `root`. */
export function mountParty(root: HTMLElement, hooks: PartyHooks): PartyView {
  const { onCount } = hooks;
  let rules = emptyRules();
  let party: Party;
  let message: Message | null = null;
  let storedOk = true;
  try {
    party = loadStoredParty();
  } catch (err) {
    // loadStoredParty kept a copy of the unreadable data; start empty.
    party = freshParty();
    message = { text: (err as Error).message, kind: "error" };
  }
  let selected = party.members.length > 0 ? 0 : -1;
  // The control the user last used, and whether the change it asked for was
  // made. The fields beside it are then empty again on the next draw.
  let used: Element | null = null;
  let changed = false;
  for (const type of ["click", "change", "submit", "keydown"])
    root.addEventListener(type, (e) => void (used = e.target as Element), true);
  // The folds that are open. A redraw builds every fold again, so it reads this.
  const open = new Set<string>();

  /** Run a change, save, and show its message (or its error). */
  // Undo: the party as it was before each recent change, newest last.
  const history: { label: string; party: string; selected: number }[] = [];
  const HISTORY = 30;

  /** Run a change, save, and show its message (or its error). A change that
   *  fails is rolled back, so a half-made change never stays. */
  function act(change: () => string | Message | void): void {
    const before = JSON.stringify(party);
    const wasSelected = selected;
    try {
      const said = change();
      const note = typeof said === "string" ? { text: said, kind: "info" as const } : said;
      history.push({
        label: note?.text || "the last change",
        party: before,
        selected: wasSelected,
      });
      if (history.length > HISTORY) history.shift();
      storedOk = storeParty(party);
      message = note?.text ? note : null;
      changed = true;
    } catch (err) {
      party = normalizeParty(JSON.parse(before), "The party");
      selected = wasSelected;
      message = { text: (err as Error).message, kind: "error" };
    }
    if (message) hooks.onNote?.(clip(message.text, 160), message.kind);
    render();
  }

  function undo(): void {
    const last = history.pop();
    if (!last) return;
    party = normalizeParty(JSON.parse(last.party), "The party");
    selected = last.selected;
    storedOk = storeParty(party);
    message = { text: `Undone: ${clip(last.label, 90)}`, kind: "info" };
    hooks.onNote?.(message.text, "info");
    render();
  }

  function render(): void {
    if (selected >= party.members.length) selected = party.members.length - 1;
    onCount(party.members.length);
    const pc = party.members[selected];
    const next = h(
      "div",
      {},
      h(
        "div",
        { class: "party" },
        partyBar(),
        statusLine(),
        party.members.length > 0 ? roster() : emptyState(),
        pc ? member(pc) : null,
      ),
    );
    // Change the drawn view in place (morph.ts): what is the same stays, with
    // its focus and scroll position. A field keeps the text typed in it,
    // unless it is in the part of the view that made this change.
    const sent = changed ? used?.closest(PARTS) : null;
    morph(root, next, { spent: (el) => !!sent && sent.contains(el) });
    changed = false;
  }

  function statusLine(): HTMLElement {
    const notes: Message[] = [];
    if (message) notes.push(message);
    if (!storedOk)
      notes.push({
        text: "This browser won't save the party. Export it before you close the page.",
        kind: "error",
      });
    const noSaves = party.members.filter(savesMissing).map((m) => m.name);
    if (noSaves.length > 0)
      notes.push({
        text: `${noSaves.join(", ")} ${noSaves.length > 1 ? "have" : "has"} no Save Targets. ${
          rules.classes.length > 0
            ? "Choose the class, or set them, under Edit character."
            : "Load your Player's Book, or set them under Edit character."
        }`,
        kind: "error",
      });
    if (rules.catalog.length === 0 && party.members.length > 0)
      notes.push({
        text: "Load your Player's Book for item weights, XP tables and runes.",
        kind: "info",
      });
    return h(
      "div",
      { class: "party-notes", role: "status", "aria-live": "polite" },
      ...notes.flatMap((n) => [
        h("p", { class: "status", "data-kind": n.kind }, n.text),
        n.details?.length
          ? h("ul", { class: "plain status-details" }, ...n.details.map((d) => h("li", {}, d)))
          : null,
      ]),
    );
  }

  /** Add members from filled-in fillable character sheets (`dw party import`).
   *  The PDFs are read here, in the browser, and go nowhere. */
  async function importSheets(files: File[]): Promise<void> {
    message = { text: `Reading ${plural(files.length, "sheet")}…`, kind: "info" };
    render();
    type Sheet = { file: string; error?: string } & Partial<ImportResult>;
    const results: Sheet[] = await Promise.all(
      files.map(async (f): Promise<Sheet> => {
        try {
          const fields = await readFormFields(new Uint8Array(await f.arrayBuffer()));
          if (Object.keys(fields).length === 0)
            return { file: f.name, error: "no form fields found. Is it a fillable sheet?" };
          return { file: f.name, ...pcFromSheet(fields, rules) };
        } catch (err) {
          return { file: f.name, error: (err as Error).message };
        }
      }),
    );
    // Ask about name clashes now: a confirm inside act() would block mid-change.
    const replace = new Set<string>();
    for (const r of results)
      if (r.pc) {
        const name = r.pc.name.toLowerCase();
        if (
          party.members.some((m) => m.name.toLowerCase() === name) &&
          confirm(`${r.pc.name} is already in the party. Replace them with ${r.file}?`)
        )
          replace.add(name);
      }
    act(() => {
      const details: string[] = [];
      let added = 0;
      for (const r of results) {
        const { pc, messages = [], unknownItems = [], encumbrance } = r;
        if (!pc) {
          details.push(`${r.file}: ${r.error ?? "it could not be read."}`);
          continue;
        }
        const at = party.members.findIndex((m) => m.name.toLowerCase() === pc.name.toLowerCase());
        if (at >= 0 && !replace.has(pc.name.toLowerCase())) {
          details.push(`${pc.name} is already in the party; ${r.file} was not imported.`);
          continue;
        }
        if (at >= 0) party.members[at] = pc;
        else party.members.push(pc);
        if (encumbrance && party.members.length === 1) party.encumbrance = encumbrance;
        selected = party.members.indexOf(pc);
        added++;
        details.push(
          `${at >= 0 ? "Replaced" : "Added"} ${pc.name} (level ${pc.level}, ${plural(pc.items.length, "item")}) from ${r.file}.`,
        );
        for (const m of messages) details.push(`${pc.name}: ${m}`);
        const unset = [!pc.kindred && "kindred", !pc.class && "class"].filter(Boolean);
        if (unset.length > 0 && rules.classes.length > 0)
          details.push(`${pc.name}: choose the ${unset.join(" and ")} under Edit character.`);
        if (unknownItems.length > 0)
          details.push(`${pc.name}: set the weight of items the book doesn't list under Gear.`);
        for (const p of loadOf(pc, party, rules).problems) details.push(`${pc.name}: ${p}`);
      }
      if (rules.classes.length === 0 && added > 0)
        details.push(
          "Load your Player's Book, then import again, to read kindreds, classes and item weights.",
        );
      return {
        text: `Imported ${plural(added, "character")} from ${plural(files.length, "sheet")}.`,
        kind: added > 0 ? "info" : "error",
        details,
      };
    });
  }

  /** Put a party from a file or a link in place of this one. The user agrees
   *  first when there is a party to lose, and Undo brings it back. */
  function take(p: Party, from: string): void {
    const now = plural(party.members.length, "member");
    if (
      party.members.length > 0 &&
      !confirm(
        `Replace the party here (${now}) with ${from} (${plural(p.members.length, "member")})?`,
      )
    )
      return;
    act(() => {
      party = p;
      selected = party.members.length > 0 ? 0 : -1;
      return {
        text: `Imported ${plural(party.members.length, "member")} from ${from}.`,
        kind: "info",
        details: repairParty(party, rules),
      };
    });
  }

  /** Copy a link that holds the party, to open in another browser. */
  async function copyLink(): Promise<void> {
    const say = (text: string, kind: Message["kind"] = "info"): void => {
      message = { text, kind };
      hooks.onNote?.(clip(text, 160), kind);
      render();
    };
    try {
      const link = await partyLink(party, location.href);
      const long = link.length > LONG_LINK ? " It is long: if an app cuts it, use Export." : "";
      const what = "It holds the party as it is now, and later changes do not follow it.";
      try {
        await navigator.clipboard.writeText(link);
        say(`A link to this party is copied. ${what}${long}`);
      } catch {
        // No clipboard (an old browser, or a page not served over https).
        prompt("Copy this link to the party:", link);
        say(`${what}${long}`);
      }
    } catch (err) {
      say(`The link could not be made (${(err as Error).message}). Use Export.`, "error");
    }
  }

  // ── the whole party ──────────────────────────────────────────────────────
  function partyBar(): HTMLElement {
    const enc = select(
      ENC_METHODS.map((m) => [m, m]),
      party.encumbrance,
      (v) => act(() => void (party.encumbrance = v as EncMethod)),
    );
    enc.setAttribute("aria-label", "Encumbrance method");

    const amount = numInput("", { min: "1", placeholder: "XP", "aria-label": "XP to award" });
    const each = h("input", { type: "checkbox", "aria-label": "Full amount to each" });
    const award = form(
      () =>
        act(() => {
          const n = parseInt(amount.value, 10);
          if (!(n > 0)) throw new Error("Enter the XP to award.");
          const isEach = (each as HTMLInputElement).checked;
          const awards = isEach
            ? party.members.filter((m) => m.status === "active").map((m) => grantXp(m, n, rules))
            : awardParty(party, n, rules);
          if (awards.length === 0) throw new Error("No active party members to award XP to.");
          const head = isEach
            ? `${n} XP each:`
            : `${n} XP split ${awards.length} ways (${awards[0].share} each before modifiers):`;
          return [
            head,
            ...awards.map(
              (a) =>
                `${a.pc.name} +${a.gained}${a.modifier ? ` (${signed(a.modifier)}%)` : ""}` +
                `${a.pc.retainer ? " (retainer: half)" : ""} → ${a.pc.xp.toLocaleString()}` +
                `${a.ready ? " ★ can level up" : ""}`,
            ),
          ].join(" · ");
        }),
      amount,
      h("label", { class: "check" }, each, "each"),
      button("Award", null, "btn", "submit"),
    );

    const file = h("input", {
      type: "file",
      accept: "application/json,.json,application/pdf,.pdf",
      multiple: "",
      hidden: "",
    });
    on(file, "change", () => {
      const files = [...((file as HTMLInputElement).files ?? [])];
      (file as HTMLInputElement).value = "";
      if (files.length === 0) return;
      const sheets = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      if (sheets.length > 0) {
        if (sheets.length < files.length) {
          message = { text: "Import one party.json, or one or more sheet PDFs.", kind: "error" };
          render();
          return;
        }
        void importSheets(sheets);
        return;
      }
      if (files.length > 1) {
        message = { text: "Import one party.json at a time.", kind: "error" };
        render();
        return;
      }
      const f = files[0];
      void readPartyFile(f).then(
        (p) => take(p, f.name),
        (err: Error) => {
          message = { text: err.message, kind: "error" };
          render();
        },
      );
    });

    return h(
      "div",
      { class: "party-bar" },
      h(
        "div",
        { class: "party-bar__group" },
        h("span", { class: "label" }, `Day ${party.day}`),
        button("Rest", () =>
          act(() => {
            const back = newDay(party);
            return (
              `Day ${party.day}. Daily rune uses are refreshed.` +
              (back ? ` ${plural(back, "cast spell")} ready again.` : "")
            );
          }),
        ),
      ),
      h("div", { class: "party-bar__group" }, h("span", { class: "label" }, "Award XP"), award),
      h(
        "div",
        { class: "party-bar__group" },
        undoButton(),
        fold(
          "bar|more",
          ["More"],
          h(
            "div",
            { class: "party-bar__group" },
            h(
              "label",
              { class: "party-bar__group" },
              h("span", { class: "label" }, "Encumbrance"),
              enc,
            ),
            button("Export", () => download("party.json", partyJson(party), "application/json")),
            button(
              "Copy link",
              () => void copyLink(),
              "btn ghost",
              "button",
              "Copy a link that opens this party in another browser",
            ),
            button(
              "Import",
              () => (file as HTMLInputElement).click(),
              "btn ghost",
              "button",
              "Import a party.json or character sheet PDFs",
            ),
          ),
          "fold fold--menu",
        ),
        file,
      ),
    );
  }

  /** A part that opens on a tap. `key` names it, so it stays open over redraws. */
  function fold(
    key: string,
    summary: (HTMLElement | string | null)[],
    body: HTMLElement | (() => HTMLElement),
    cls = "fold",
  ): HTMLElement {
    // A body given as a function is built only while the fold is open, so a
    // closed fold costs one line.
    const built = (): HTMLElement => (typeof body === "function" ? body() : body);
    const head = h("summary", { "data-key": key }, ...summary);
    const d = h(
      "details",
      open.has(key) ? { class: cls, open: "" } : { class: cls },
      head,
      typeof body !== "function" || open.has(key) ? built() : null,
    ) as HTMLDetailsElement;
    // The view keeps the drawn elements, so read them from the event.
    on(head, "click", (e) => {
      const el = (e.currentTarget as HTMLElement).parentElement!;
      if (el.childElementCount < 2) el.append(built());
    });
    on(d, "toggle", (e) => {
      if ((e.currentTarget as HTMLDetailsElement).open) open.add(key);
      else open.delete(key);
    });
    return d;
  }

  /** A change to a member's HP: `spec` is -N, +N or max (applyHp). */
  const hpChange =
    (pc: PC, spec: string | (() => string)): (() => void) =>
    () =>
      act(() => {
        applyHp(pc, typeof spec === "string" ? spec : spec());
        return hpSaid(pc);
      });

  function roster(): HTMLElement {
    // The columns a narrow screen drops (app.css) are marked `opt`.
    const head = ["Name", "Kindred & Class", "Lvl", "XP", "HP", "AC", "Load", "Speed"];
    const cls = ["", "opt", "num", "num opt", "num", "num", "num opt", "num"];
    const rows = party.members.map((pc, i) => {
      const load = loadOf(pc, party, rules);
      const klass = classOf(rules, pc.class);
      const next = nextLevelXp(pc, klass);
      const flags = `${pc.retainer ? " (r)" : ""}${pc.status !== "active" ? ` [${pc.status}]` : ""}`;
      const pickBtn = button(
        pc.name + flags,
        () => {
          selected = i;
          message = null;
          render();
        },
        "linkish",
      );
      if (i === selected) pickBtn.setAttribute("aria-current", "true");
      const text = (k: number, value: string): HTMLElement => h("td", { class: cls[k] }, value);
      return h(
        "tr",
        i === selected ? { class: "is-selected" } : {},
        h("td", {}, pickBtn, load.problems.length ? h("span", { class: "warn" }, " !") : null),
        text(1, kindredClass(pc, rules)),
        text(2, `${pc.level}`),
        text(
          3,
          `${pc.xp.toLocaleString()}${next !== null ? `/${next.toLocaleString()}` : ""}${canLevel(pc, klass) ? " ★" : ""}`,
        ),
        // Damage or heal anyone from here, with no need to select them.
        h(
          "td",
          { class: "num hp-cell" },
          button("−", hpChange(pc, "-1"), "btn mini", "button", `Damage ${pc.name} by 1`),
          h("span", { class: pc.hp <= 0 ? "hp-now warn" : "hp-now" }, `${pc.hp}/${pc.maxHp}`),
          button("+", hpChange(pc, "+1"), "btn mini", "button", `Heal ${pc.name} by 1`),
        ),
        text(5, `${computeAc(pc, rules.catalog)}`),
        text(
          6,
          party.encumbrance === "slots"
            ? `${load.equippedSlots}+${load.stowedSlots}`
            : party.encumbrance === "basic"
              ? "-"
              : `${load.weight}`,
        ),
        text(7, load.speed > 0 ? `${load.speed}` : "0 !"),
      );
    });
    const speeds = party.members
      .filter((m) => m.status === "active")
      .map((m) => loadOf(m, party, rules).speed);
    return h(
      "div",
      { class: "party-roster" },
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h("tr", {}, ...head.map((t, k) => h("th", cls[k] ? { class: cls[k] } : {}, t))),
          ),
          h("tbody", {}, ...rows),
        ),
      ),
      speeds.length
        ? h(
            "p",
            { class: "hint" },
            `Party Speed ${Math.min(...speeds)} (the slowest active member).`,
          )
        : null,
    );
  }

  // ── one member ───────────────────────────────────────────────────────────
  function member(pc: PC): HTMLElement {
    const data = hooks.sheet(pc, party, rules);
    return h(
      "article",
      // The key makes another member a new element, with no state of this one.
      { class: "member", "aria-label": pc.name, "data-key": pc.name },
      playStrip(pc, data),
      h(
        "div",
        { class: "member__cols" },
        h(
          "div",
          { class: "member__main" },
          abilityStrip(pc, data),
          quickRow(pc),
          ...castBlocks(pc, data),
          block("Gear", gearBlock(pc)),
          block("Coins", coinBlock(pc)),
          block("Notes", notesBlock(pc)),
        ),
        reference(pc, data),
      ),
      editFold(pc),
      printable(data),
    );
  }

  /** The strip that stays in view: who it is, the HP and its controls, then the
   *  numbers a fight asks for. */
  function playStrip(pc: PC, data: SheetData): HTMLElement {
    const load = loadOf(pc, party, rules);
    const n = numInput("", {
      min: "1",
      placeholder: "n",
      class: "cell",
      "aria-label": "Hit points to take or heal",
    });
    const amount = (): number => {
      const v = parseInt(n.value, 10);
      if (!(v > 0)) throw new Error("Enter an amount of HP.");
      return v;
    };
    // Enter in the amount field takes damage, the common case.
    const hp = form(
      hpChange(pc, () => `-${amount()}`),
      button("−", hpChange(pc, "-1"), "btn mini", "button", "Damage 1"),
      h(
        "span",
        { class: pc.hp <= 0 ? "hp__now warn" : "hp__now" },
        h("b", {}, `${pc.hp}`),
        `/${pc.maxHp}`,
      ),
      button("+", hpChange(pc, "+1"), "btn mini", "button", "Heal 1"),
      n,
      button("Dmg", null, "btn mini", "submit", "Damage by the amount"),
      button(
        "Heal",
        hpChange(pc, () => `+${amount()}`),
        "btn mini",
        "button",
        "Heal by the amount",
      ),
      button("Full", hpChange(pc, "max"), "btn mini", "button", "Heal to full"),
    );
    hp.classList.add("hp");
    const s = pc.saves;
    const cells: [string, string][] = [
      ["AC", `${computeAc(pc, rules.catalog)}`],
      ["Atk", signed(pc.attack)],
      ["Spd", load.speed > 0 ? `${load.speed}` : "0 !"],
      ...SAVE_KEYS.map((k): [string, string] => [SAVE_LABEL[k], s[k] ? `${s[k]}` : "–"]),
    ];
    if (pc.magicResistance > 0) cells.push(["MR", `+${pc.magicResistance}`]);
    return h(
      "header",
      { class: "play-strip" },
      h(
        "div",
        { class: "play-strip__who" },
        h("h2", { class: "play-strip__name" }, pc.name),
        h("p", { class: "play-strip__sub" }, data.badges.join(" · ")),
      ),
      h("div", { class: "play-strip__hp" }, h("span", { class: "label" }, "HP"), hp),
      h(
        "dl",
        { class: "cells" },
        ...cells.map(([k, v], i) =>
          h("div", i === 3 ? { class: "cells__first-save" } : {}, h("dt", {}, k), h("dd", {}, v)),
        ),
      ),
    );
  }

  /** The six abilities on one line, then the skill targets and languages. */
  function abilityStrip(pc: PC, data: SheetData): HTMLElement {
    const prime = new Set(data.prime);
    const skills = skillBadges(pc.skills);
    return h(
      "div",
      { class: "member__block" },
      h(
        "dl",
        { class: "cells cells--six" },
        ...ABILITIES.map((a) =>
          h(
            "div",
            prime.has(a) ? { class: "is-prime", title: "A prime ability of the class" } : {},
            h("dt", {}, a),
            h(
              "dd",
              {},
              `${pc.scores[a]}`,
              h("span", { class: "mod" }, signed(abilityMod(pc.scores[a]))),
            ),
          ),
        ),
      ),
      skills.length ? h("div", { class: "chips" }, ...skills) : null,
      pc.languages.length
        ? h(
            "p",
            { class: "hint" },
            h("span", { class: "label" }, "Languages "),
            pc.languages.join(", "),
          )
        : null,
    );
  }

  /** XP and gold, changed where they show. */
  function quickRow(pc: PC): HTMLElement {
    const klass = classOf(rules, pc.class);
    const next = nextLevelXp(pc, klass);
    const mod = xpModifier(pc, rules);
    const add = numInput("", {
      min: "1",
      placeholder: "XP",
      class: "cell",
      "aria-label": "XP to add",
    });
    const addForm = form(
      () =>
        act(() => {
          const v = parseInt(add.value, 10);
          if (!(v > 0)) throw new Error("Enter the XP to add.");
          const a = grantXp(pc, v, rules);
          return `${pc.name} +${a.gained}${a.modifier ? ` (${signed(a.modifier)}%)` : ""} → ${pc.xp.toLocaleString()} XP${a.ready ? " ★ can level up" : ""}`;
        }),
      add,
      button("Add", null, "btn mini", "submit", "Add XP"),
    );
    return h(
      "div",
      { class: "quick" },
      h(
        "div",
        { class: "quick__group" },
        h("span", { class: "label" }, `XP${mod ? ` (${signed(mod)}%)` : ""}`),
        h(
          "span",
          { class: "quick__val" },
          `${pc.xp.toLocaleString()}${next !== null ? ` / ${next.toLocaleString()}` : ""}`,
        ),
        addForm,
        canLevel(pc, klass)
          ? button("Level up ★", () => doLevelUp(pc, ""), "btn mini accent")
          : null,
      ),
      h(
        "label",
        { class: "quick__group" },
        h("span", { class: "label" }, "Gold"),
        numInput(`${pc.coins.gp}`, { min: "0", class: "cell", "aria-label": "Gold carried" }, (v) =>
          act(() => void (pc.coins.gp = Math.max(0, v))),
        ),
      ),
    );
  }

  /** One line of a list that opens to its rules text, with its action beside. */
  function entry(
    key: string,
    name: string,
    tag: string,
    body: HTMLElement,
    action: HTMLElement | null = null,
  ): HTMLElement {
    return h(
      "li",
      { class: "entry" },
      fold(
        key,
        [h("span", { class: "tn" }, name), tag ? h("span", { class: "fold__tag" }, tag) : null],
        body,
      ),
      action,
    );
  }

  /** What the member can cast or use, each a line that opens to its text. */
  function castBlocks(pc: PC, data: SheetData): HTMLElement[] {
    const runes = pc.runes.map((r, i) => {
      const st = runeStatus(r, pc, party.day, rules.runes);
      const d = data.runes[i];
      const use = button(
        "Use",
        () => {
          const force =
            st.left === 0 && confirm(`${pc.name} has no uses of ${r.name} left. Use it anyway?`);
          if (st.left === 0 && !force) return;
          act(() => {
            const after = useRune(findRune(pc, r.name), pc, party.day, rules.runes, force);
            return `${pc.name} uses ${r.name}${after.left === null ? "." : `: ${after.left}/${after.limit} left (${after.band?.text}).`}`;
          });
        },
        st.left === 0 ? "btn mini" : "btn mini accent",
        "button",
        `Use ${r.name}`,
      );
      return entry(
        `${pc.name}|rune|${r.name}`,
        `${r.name}${r.times > 1 ? ` ×${r.times}` : ""}`,
        tags(
          r.magnitude,
          st.left === null ? st.band?.text : `${st.left}/${st.limit} left`,
          d?.duration,
          d?.range,
        ),
        castingEntry(r.name, null, d?.duration ?? null, d?.range ?? null, d?.text || NO_TEXT),
        use,
      );
    });
    const spells = spellRows(pc, data);
    const glamours = data.glamours.map((g) =>
      entry(
        `${pc.name}|glamour|${g.name}`,
        g.name,
        tags(g.duration, g.range),
        castingEntry(g.name, null, g.duration, g.range, g.body ?? NO_TEXT),
      ),
    );
    const knacks = data.knacks.map((k) =>
      entry(
        `${pc.name}|knack|${k.name}`,
        k.name,
        clip(k.text, TAG_LENGTH),
        traitParagraph({ name: k.name, text: k.text || NO_TEXT }),
      ),
    );
    return [
      spells,
      list("Runes", runes),
      list("Glamours", glamours),
      list("Knacks", knacks),
    ].filter((b): b is HTMLElement => b !== null);
  }

  /**
   * The member's spells. A class with spells per day shows its slots by Rank,
   * the spells in them (each with Cast), and the spells that can fill a slot.
   * Any other member shows the spells they know.
   */
  function spellRows(pc: PC, data: SheetData): HTMLElement | null {
    const detail = (name: string): SheetData["spells"][number] =>
      data.spells.find((s) => s.name === name) ??
      hooks.spell?.(name) ?? {
        name,
        tradition: null,
        rank: null,
        duration: null,
        range: null,
        body: null,
      };
    const line = (key: string, name: string, state: string, action: HTMLElement | null) => {
      const sp = detail(name);
      return entry(
        key,
        name,
        tags(state, sp.rank ? `rank ${sp.rank}` : sp.tradition, sp.duration, sp.range),
        castingEntry(sp.name, null, sp.duration, sp.range, sp.body ?? NO_TEXT),
        action,
      );
    };
    const use = slotUse(pc, rules);
    if (use.length === 0 && pc.prepared.length === 0)
      return list(
        "Spells",
        pc.spells.map((name) => line(`${pc.name}|spell|${name}`, name, "", null)),
      );

    const ready = pc.prepared.map((p, i) =>
      line(
        `${pc.name}|prepared|${p.name}|${i}`,
        p.name,
        p.cast ? "cast" : "",
        h(
          "span",
          { class: "entry__acts" },
          p.cast
            ? null
            : button(
                "Cast",
                () => act(() => `${pc.name} casts ${castSpell(pc, p.name)}.`),
                "btn mini accent",
                "button",
                `Cast ${p.name}`,
              ),
          button(
            "×",
            () =>
              act(() => {
                pc.prepared.splice(i, 1);
                return `${pc.name} clears ${p.name} from its slot.`;
              }),
            "btn mini ghost",
            "button",
            `Clear ${p.name} from its slot`,
          ),
        ),
      ),
    );
    const free = new Map(use.map((u) => [u.rank, u.slots - u.filled]));
    const pool = preparable(pc, rules);
    const choices = pool.map((s) => {
      const room = s.rank === null || (free.get(s.rank) ?? 0) > 0;
      const add = button(
        "Prepare",
        () => act(() => `${pc.name} prepares ${prepareSpell(pc, rules, s.name)}.`),
        "btn mini",
        "button",
        `Prepare ${s.name}`,
      ) as HTMLButtonElement;
      add.disabled = !room;
      return line(`${pc.name}|can|${s.name}`, s.name, "", add);
    });
    const freeSlots = [...free.values()].reduce((a, n) => a + Math.max(0, n), 0);
    const slots = h(
      "p",
      { class: "slots" },
      ...use.map((u) =>
        h(
          "span",
          { class: u.ready > 0 ? "slot" : "slot slot--out" },
          `Rank ${u.rank} `,
          h("b", {}, `${u.ready}/${u.slots}`),
        ),
      ),
      h("span", { class: "hint" }, "ready to cast. Rest brings a cast spell back."),
    );
    const none =
      pool.length === 0
        ? h(
            "p",
            { class: "hint" },
            learnsSpells(pc, rules)
              ? "No spell known for these slots. Add spells under Edit character."
              : "The saved book gives no spell for these slots. Add spells under Edit character.",
          )
        : null;
    return block(
      "Spells",
      h(
        "div",
        { class: "stack" },
        slots,
        ready.length ? h("ul", { class: "entries" }, ...ready) : null,
        none,
        choices.length
          ? fold(
              `${pc.name}|prepare`,
              [
                h("span", { class: "tn" }, "Prepare a spell"),
                h(
                  "span",
                  { class: "fold__tag" },
                  freeSlots > 0 ? `${plural(freeSlots, "slot")} free` : "every slot is full",
                ),
              ],
              h("ul", { class: "entries" }, ...choices),
              "fold fold--menu",
            )
          : null,
      ),
    );
  }

  /** The kindred and class abilities, one line each; beside the controls on a
   *  wide screen. Each opens to its text. */
  function reference(pc: PC, data: SheetData): HTMLElement {
    const keys: string[] = [];
    const groups = [data.kindredTraits, data.classTraits]
      .filter((g) => g.traits.length > 0)
      .map((g) =>
        block(
          g.title,
          h(
            "ul",
            { class: "entries" },
            ...g.traits.map((t) => {
              const key = `${pc.name}|${g.title}|${t.name}`;
              keys.push(key);
              return entry(key, t.name, clip(t.text, TAG_LENGTH), traitParagraph(t));
            }),
          ),
        ),
      );
    const allOpen = keys.length > 0 && keys.every((k) => open.has(k));
    const about = [...data.physique, ...data.persona].filter(([, v]) => v);
    return h(
      "aside",
      { class: "member__ref", "aria-label": "Abilities" },
      keys.length > 1
        ? h(
            "div",
            { class: "row" },
            button(
              allOpen ? "Close all" : "Open all",
              () => {
                for (const k of keys)
                  if (allOpen) open.delete(k);
                  else open.add(k);
                render();
              },
              "btn mini",
              "button",
              "Open or close every ability",
            ),
          )
        : null,
      ...groups,
      about.length
        ? fold(
            `${pc.name}|about`,
            [
              h("span", { class: "tn" }, "Physique and persona"),
              h("span", { class: "fold__tag" }, about.map(([, v]) => v).join(", ")),
            ],
            h(
              "dl",
              { class: "kv" },
              ...about.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))),
            ),
          )
        : null,
    );
  }

  /** What a session rarely changes: levels, maximum HP, what the member knows,
   *  who they are, and the sheet itself. Closed until asked for. */
  function editFold(pc: PC): HTMLElement {
    const mod = xpModifier(pc, rules);
    return fold(
      `${pc.name}|edit`,
      [
        h("span", { class: "tn" }, "Edit character"),
        h(
          "span",
          { class: "fold__tag" },
          "level up, maximum HP, runes, glamours, knacks, spells, name, print, remove",
        ),
      ],
      () =>
        h(
          "div",
          { class: "member__grid" },
          block(`Level${mod ? ` (XP ${signed(mod)}%)` : ""}`, levelBlock(pc)),
          block("Hit points", maxHpBlock(pc)),
          block("Runes", runeBlock(pc)),
          block("Glamours", listBlock(pc, "glamours", rules.glamours)),
          block("Knacks", listBlock(pc, "knacks", rules.knacks)),
          block("Spells known", listBlock(pc, "spells", spellNames(pc))),
          block("Character", detailBlock(pc)),
          block(
            "Sheet",
            h(
              "div",
              { class: "row" },
              button("Print sheet", printSheet),
              button("Download .md", () =>
                download(
                  `${safeName(pc.name, "character")}.md`,
                  pcMarkdown(pc, party, rules),
                  "text/markdown",
                ),
              ),
              button("Remove", () => {
                if (!confirm(`Remove ${pc.name} from the party?`)) return;
                act(() => {
                  party.members = party.members.filter((m) => m !== pc);
                  return `Removed ${pc.name} from the party.`;
                });
              }),
            ),
          ),
        ),
      "fold member__edit",
    );
  }

  function maxHpBlock(pc: PC): HTMLElement {
    return h(
      "label",
      { class: "row" },
      h("span", { class: "label" }, "Max HP"),
      numInput(`${pc.maxHp}`, { min: "1", "aria-label": "Maximum HP" }, (v) =>
        act(() => {
          pc.maxHp = Math.max(1, v);
          pc.hp = Math.min(pc.hp, pc.maxHp);
        }),
      ),
    );
  }

  /** Level the member up. `roll` is the player's own HP die roll, or "". */
  function doLevelUp(pc: PC, roll: string): void {
    const klass = classOf(rules, pc.class);
    if (!klass) return;
    if (
      !canLevel(pc, klass) &&
      !confirm(`${pc.name} doesn't have the XP for level ${pc.level + 1}. Level up anyway?`)
    )
      return;
    act(() => levelSummary(pc, levelUp(pc, klass, roll ? { hp: parseInt(roll, 10) } : {})));
  }

  function levelBlock(pc: PC): HTMLElement {
    const klass = classOf(rules, pc.class);
    const next = nextLevelXp(pc, klass);
    const hpRoll = numInput("", {
      min: "0",
      placeholder: "roll",
      "aria-label": "Your hit point roll",
    });
    const ready = canLevel(pc, klass);
    const hasTable = !!klass?.advancement?.length;
    const lvl = button(
      ready ? "Level up" : "Level up anyway",
      () => doLevelUp(pc, hpRoll.value),
      ready ? "btn" : "btn ghost",
    );
    if (!hasTable || next === null) (lvl as HTMLButtonElement).disabled = true;
    return h(
      "div",
      { class: "stack" },
      h(
        "p",
        { class: "hint" },
        !hasTable
          ? "No advancement table for this class (load the Player's Book)."
          : next === null
            ? `Top of the ${klass!.name} table.`
            : `Level ${pc.level + 1} at ${next.toLocaleString()} XP.${ready ? " Ready to level up." : ""}`,
      ),
      h("div", { class: "row" }, hpRoll, lvl),
      h("p", { class: "hint" }, "Enter your own HP die roll, or leave it blank to roll."),
    );
  }

  function levelSummary(pc: PC, up: ReturnType<typeof levelUp>): string {
    const parts = [
      `${pc.name} reaches level ${up.to}!`,
      `HP +${up.hpGained} [${up.hpRoll}] → ${pc.hp}/${pc.maxHp}`,
    ];
    if (up.attack[0] !== up.attack[1])
      parts.push(`Attack ${signed(up.attack[0])} → ${signed(up.attack[1])}`);
    const saves = (Object.keys(up.saves[1]) as (keyof PC["saves"])[]).filter(
      (k) => up.saves[0][k] !== up.saves[1][k],
    );
    if (saves.length)
      parts.push(
        `Saves ${saves.map((k) => `${k} ${up.saves[0][k]} → ${up.saves[1][k]}`).join(", ")}`,
      );
    for (const [k, [a, b]] of Object.entries(up.extras)) parts.push(`${k} ${a || "-"} → ${b}`);
    const want = allowedCount(pc, rules, "glamours");
    if (want !== null && want > pc.glamours.length)
      parts.push(`Add ${want - pc.glamours.length} glamour(s) under Edit character`);
    if (gainsRunesOnLevel(pc, rules)) parts.push("Roll for a new rune under Edit character");
    parts.push(`Check the class entry for new spells, skills and traits`);
    return parts.join(" · ");
  }

  function gearBlock(pc: PC): HTMLElement {
    const load = loadOf(pc, party, rules);
    // Only the number the party's encumbrance method counts gets a column.
    const measure: "weight" | "slots" | null =
      party.encumbrance === "weight" ? "weight" : party.encumbrance === "slots" ? "slots" : null;
    const rows = pc.items.map((it) =>
      h(
        "tr",
        {},
        h(
          "td",
          {},
          it.name,
          it.note ? h("span", { class: "muted" }, ` (${it.note})`) : null,
          it.treasure ? h("span", { class: "tag" }, "treasure") : null,
          it.bulky ? h("span", { class: "tag" }, "bulky") : null,
          it.ref && it.ref !== it.name ? h("span", { class: "muted" }, ` = ${it.ref}`) : null,
        ),
        h("td", { class: "num" }, itemNum(pc, it, "qty", 0)),
        measure ? h("td", { class: "num" }, itemNum(pc, it, measure, 0)) : null,
        h(
          "td",
          {},
          button(
            it.where,
            () =>
              act(() => {
                const to: Where = it.where === "equipped" ? "stowed" : "equipped";
                if (to === "stowed" && it.bulky)
                  throw new Error(`${it.name} is bulky: it takes two hands and can't be stowed.`);
                it.where = to;
                return `${pc.name}: ${it.name} → ${to}`;
              }),
            "linkish",
          ),
        ),
        h(
          "td",
          { class: "num" },
          button(
            "-1",
            () => act(() => (removeItem(pc, it, 1), `${pc.name} -1 ${it.name}`)),
            "btn mini",
            "button",
            `Remove one ${it.name}`,
          ),
          button(
            "x",
            () => act(() => (removeItem(pc, it), `${pc.name} drops ${it.name}`)),
            "btn mini",
            "button",
            `Remove all ${it.name}`,
          ),
        ),
      ),
    );

    const listId = "catalog-items";
    const name = h("input", {
      type: "text",
      list: listId,
      placeholder: rules.catalog.length ? "item, from the book's lists" : "item",
      "aria-label": "Item to add",
    }) as HTMLInputElement;
    const qty = numInput("", { min: "1", placeholder: "qty", "aria-label": "Quantity" });
    const where = select(
      [
        ["", "auto"],
        ["equipped", "equipped"],
        ["stowed", "stowed"],
      ],
      "",
    );
    where.setAttribute("aria-label", "Where it goes");
    const names = [...new Set(rules.catalog.map((c) => c.name))];
    const addForm = form(
      () =>
        act(() => {
          const text = name.value.trim();
          if (!text) throw new Error("Name the item to add.");
          const { inv, resolved } = makeItem(rules.catalog, rules.enc, text, {
            qty: qty.value ? parseInt(qty.value, 10) : undefined,
            where: (where.value || undefined) as Where | undefined,
          });
          const stacked = addItem(pc, inv);
          const found = resolved.item
            ? `${resolved.item.name}: ${inv.weight} coins${inv.qty > 1 ? " each" : ""}, ${plural(inv.slots, "slot")}`
            : `not in the book's lists: weight ${inv.weight}, set it in the table`;
          return `${pc.name} +${inv.qty} ${inv.name} → ${inv.where} [${found}]${stacked.qty !== inv.qty ? ` (now ×${stacked.qty})` : ""}`;
        }),
      name,
      qty,
      where,
      button("Add", null, "btn", "submit"),
      h("datalist", { id: listId }, ...names.map((n) => h("option", { value: n }))),
    );
    addForm.classList.add("add-item");

    return h(
      "div",
      { class: "stack" },
      h("p", { class: "load-line" }, describeLoad(load)),
      ...load.problems.map((p) => h("p", { class: "status", "data-kind": "error" }, p)),
      pc.items.length
        ? h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "gear" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  h("th", {}, "Item"),
                  h("th", { class: "num" }, "Qty"),
                  measure
                    ? h("th", { class: "num" }, measure === "weight" ? "Coins" : "Slots")
                    : null,
                  h("th", {}, "Where"),
                  h("th", { class: "num" }, ""),
                ),
              ),
              h("tbody", {}, ...rows),
            ),
          )
        : h("p", { class: "hint" }, "Carrying nothing."),
      addForm,
      h(
        "p",
        { class: "hint" },
        measure
          ? `${measure === "weight" ? "Coins" : "Slots"} are per item. Click where an item is to move it.`
          : "Click where an item is to move it.",
      ),
    );
  }

  /** An editable number cell for one item field. A quantity of 0 drops the item. */
  function itemNum(
    pc: PC,
    it: InvItem,
    field: "qty" | "weight" | "slots",
    min: number,
  ): HTMLElement {
    return numInput(
      `${it[field]}`,
      { min: `${min}`, class: "cell", "aria-label": `${it.name} ${field}` },
      (v) =>
        act(() => {
          it[field] = Math.max(min, v);
          if (field === "qty" && it.qty <= 0) {
            pc.items = pc.items.filter((i) => i !== it);
            return `${pc.name} drops ${it.name}`;
          }
        }),
    );
  }

  function coinBlock(pc: PC): HTMLElement {
    const row = (label: string, purse: PC["coins"]) =>
      h(
        "tr",
        {},
        h("th", {}, label),
        ...COIN_KINDS.map((k) =>
          h(
            "td",
            { class: "num" },
            numInput(
              `${purse[k]}`,
              { min: "0", class: "cell", "aria-label": `${label} ${k}` },
              (v) => act(() => void (purse[k] = Math.max(0, v))),
            ),
          ),
        ),
      );
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "coins" },
          h(
            "thead",
            {},
            h("tr", {}, h("th", {}, ""), ...COIN_KINDS.map((k) => h("th", { class: "num" }, k))),
          ),
          h("tbody", {}, row("Carried", pc.coins), row("Banked", pc.banked)),
        ),
      ),
      h(
        "p",
        { class: "hint" },
        `Carried coins count toward the load. Banked: ${formatCoins(pc.banked)}.`,
      ),
    );
  }

  function runeBlock(pc: PC): HTMLElement {
    const rows = pc.runes.map((r) => {
      const st = runeStatus(r, pc, party.day, rules.runes);
      return h(
        "li",
        {},
        h("span", {}, `${r.name}${r.times > 1 ? ` ×${r.times}` : ""}`),
        h(
          "span",
          { class: "muted" },
          ` ${r.magnitude || "?"}, ${st.band?.text ?? "frequency unknown"}${st.left === null ? "" : `, ${st.left}/${st.limit} left`}`,
        ),
        h(
          "span",
          { class: "row-end" },
          removeBtn(`${r.name}`, () => {
            pc.runes = pc.runes.filter((x) => x !== r);
            return `${pc.name} loses ${r.name}.`;
          }),
        ),
      );
    });
    const book = rules.runes.runes;
    const choose = select(
      [
        ["", book.length ? "grant a rune…" : "no runes indexed"],
        ...book.map((r): [string, string] => [r.name, `${r.name} (${r.magnitude})`]),
      ],
      "",
    );
    choose.setAttribute("aria-label", "Rune to grant");
    const grant = button("Grant", () =>
      act(() => {
        const found = lookupRune(rules.runes, choose.value);
        if (!choose.value || !found) throw new Error("Choose a rune to grant.");
        const { rune, duplicate } = grantRune(pc, found);
        return duplicate
          ? `${pc.name} is granted ${rune.name} again: its uses are doubled (×${rune.times}).`
          : `${pc.name} is granted ${rune.name} (${rune.magnitude}).`;
      }),
    );
    if (!book.length)
      (grant as HTMLButtonElement).disabled = (choose as HTMLSelectElement).disabled = true;
    const learn = button("Roll for a rune", () =>
      act(() => {
        const g = rollRuneGrant(rules.runes, pc.level);
        const bonus = g.bonus ? ` ${g.bonus > 0 ? "+" : "-"} ${Math.abs(g.bonus)}` : "";
        let text = `${pc.name} rolls 2d6 ${g.dice}${bonus} = ${g.total}: ${g.text}`;
        if (g.entry) {
          const { rune, duplicate } = grantRune(pc, g.entry);
          text += duplicate
            ? ` · ${rune.name}, already known: uses doubled (×${rune.times})`
            : ` · ${rune.name} (${rune.magnitude})`;
        }
        return text;
      }),
    );
    if (rules.runes.granted.length === 0) (learn as HTMLButtonElement).disabled = true;
    return h(
      "div",
      { class: "stack" },
      pc.runes.length
        ? h("ul", { class: "plain" }, ...rows)
        : h("p", { class: "hint" }, "No runes."),
      h("div", { class: "row" }, choose, grant),
      learn,
    );
  }

  function listBlock(pc: PC, field: NameList, known: string[]): HTMLElement {
    const list = pc[field];
    const listId = `known-${field}`;
    const input = h("input", {
      type: "text",
      list: listId,
      placeholder: known.length
        ? `a ${field.replace(/s$/, "")} from the book`
        : `${field.replace(/s$/, "")} name`,
      "aria-label": `${field} to add`,
    }) as HTMLInputElement;
    const allowed = allowedCount(pc, rules, field);
    const addForm = form(
      () =>
        act(() => {
          // A spell of the table's own making is not in the book.
          const added = learnName(pc, field, known, input.value, {
            force: field === "spells",
          });
          return `${pc.name} learns ${added}.`;
        }),
      input,
      button("Add", null, "btn ghost", "submit"),
      known.length
        ? h("datalist", { id: listId }, ...known.map((k) => h("option", { value: k })))
        : null,
    );
    return h(
      "div",
      { class: "stack" },
      list.length
        ? h(
            "ul",
            { class: "chips-list" },
            ...list.map((name) =>
              h(
                "li",
                {},
                name,
                removeBtn(name, () => `${pc.name} forgets ${forgetName(pc, field, name)}.`),
              ),
            ),
          )
        : h("p", { class: "hint" }, "None."),
      addForm,
      known.length
        ? button("Add one at random", () =>
            act(() => `${pc.name} learns ${learnName(pc, field, known, "", { random: true })}.`),
          )
        : null,
      allowed !== null
        ? h(
            "p",
            { class: "hint" },
            `The class gives ${allowed} at level ${pc.level}${list.length > allowed ? "; this list has more (a kindred can add some)" : ""}.`,
          )
        : null,
    );
  }

  /** The book's spells the member can learn: their tradition's, else all. */
  function spellNames(pc: PC): string[] {
    const mine = traditionSpells(pc, rules);
    return (mine.length ? mine : rules.spells).map((s) => s.name);
  }

  function notesBlock(pc: PC): HTMLElement {
    const input = h("input", {
      type: "text",
      placeholder: "a note",
      "aria-label": "Note to add",
    }) as HTMLInputElement;
    return h(
      "div",
      { class: "stack" },
      pc.notes.length
        ? h(
            "ol",
            { class: "plain" },
            ...pc.notes.map((n, k) =>
              h(
                "li",
                {},
                h("span", {}, n),
                h(
                  "span",
                  { class: "row-end" },
                  removeBtn(`note ${k + 1}`, () => {
                    pc.notes.splice(k, 1);
                    return "Note removed.";
                  }),
                ),
              ),
            ),
          )
        : null,
      form(
        () =>
          act(() => {
            const text = input.value.trim();
            if (!text) throw new Error("Write the note first.");
            pc.notes.push(text);
          }),
        input,
        button("Add", null, "btn ghost", "submit"),
      ),
    );
  }

  function detailBlock(pc: PC): HTMLElement {
    const text = (label: string, key: "name" | "player" | "alignment" | "background") =>
      h(
        "label",
        { class: "field" },
        h("span", { class: "label" }, label),
        textInput(pc[key], (v) =>
          act(() => {
            if (key === "name") {
              const nm = v.trim();
              if (!nm) throw new Error("A character needs a name.");
              if (party.members.some((m) => m !== pc && m.name.toLowerCase() === nm.toLowerCase()))
                throw new Error(`${nm} is already in the party.`);
              pc.name = nm;
            } else pc[key] = v.trim();
          }),
        ),
      );
    const status = select(
      [
        ["active", "active"],
        ["retired", "retired"],
        ["dead", "dead"],
      ],
      pc.status,
      (v) => act(() => void (pc.status = v as PC["status"])),
    );
    // Kindred and class from the book. A sheet's unrecognised one is fixed here.
    const choice = (
      label: string,
      key: "kindred" | "class",
      options: { id: string; name: string }[],
    ): HTMLElement | null => {
      if (options.length === 0) return null;
      const known = options.some((o) => o.id === pc[key]);
      const el = select(
        [
          ...(known ? [] : [["", pc[key] || "(not set)"] as [string, string]]),
          ...options.map((o): [string, string] => [o.id, o.name]),
        ],
        known ? pc[key] : "",
        (v) =>
          act(() => {
            if (!v) return;
            setField(pc, rules, `${key}=${v}`);
            // A new class re-reads Attack and Saves for the PC's level.
            if (key === "class") setField(pc, rules, `level=${pc.level}`);
            return `${pc.name}: ${key} set to ${options.find((o) => o.id === v)?.name ?? v}.`;
          }),
      );
      el.setAttribute("aria-label", label);
      return h("label", { class: "field" }, h("span", { class: "label" }, label), el);
    };
    const retainer = h(
      "input",
      pc.retainer ? { type: "checkbox", checked: "" } : { type: "checkbox" },
    ) as HTMLInputElement;
    on(retainer, "change", () => act(() => void (pc.retainer = retainer.checked)));
    return h(
      "div",
      { class: "stack" },
      text("Name", "name"),
      text("Player", "player"),
      choice("Kindred", "kindred", rules.kindreds),
      choice("Class", "class", rules.classes),
      text("Alignment", "alignment"),
      h("label", { class: "field" }, h("span", { class: "label" }, "Status"), status),
      h(
        "label",
        { class: "field" },
        h("span", { class: "label" }, "AC bonus (magic, natural armour)"),
        numInput(`${pc.acBonus}`, { "aria-label": "AC bonus" }, (v) =>
          act(() => void (pc.acBonus = v)),
        ),
      ),
      h(
        "div",
        { class: "row row--nums" },
        ...(["attack", ...SAVE_KEYS] as const).map((k) =>
          h(
            "label",
            { class: "field field--num" },
            h("span", { class: "label" }, k === "attack" ? "Attack" : SAVE_LABEL[k]),
            numInput(
              `${k === "attack" ? pc.attack : pc.saves[k]}`,
              { "aria-label": k === "attack" ? "Attack" : `${SAVE_LABEL[k]} Save Target` },
              (v) => act(() => setField(pc, rules, `${k}=${v}`)),
            ),
          ),
        ),
      ),
      h("label", { class: "check" }, retainer, "Retainer (earns half XP)"),
    );
  }

  function undoButton(): HTMLElement {
    const last = history.at(-1);
    // A fixed label keeps focus on Undo across redraws; the title says what it undoes.
    const b = button("Undo", undo);
    b.title = last ? `Undo: ${clip(last.label, 90)}` : "Nothing to undo";
    if (!last) (b as HTMLButtonElement).disabled = true;
    return b;
  }

  // ── small builders ───────────────────────────────────────────────────────
  function removeBtn(what: string, change: () => string): HTMLElement {
    return button("x", () => act(change), "btn mini", "button", `Remove ${what}`);
  }

  render();

  return {
    offer: take,
    setRules(r) {
      rules = r;
      // Members saved with no Save Targets take them from the book's tables.
      const fixed = repairParty(party, rules);
      if (fixed.length > 0) {
        storedOk = storeParty(party);
        const text = fixed.some((f) => f.includes("Save Targets"))
          ? "Save Targets were missing."
          : "Gear slots are counted again.";
        message = { text, kind: "info", details: fixed };
      }
      render();
    },
    add(character) {
      const pc = characterToPc(character, rules);
      // A second character with the same name gets a number, as names find members.
      const base = pc.name;
      for (
        let n = 2;
        party.members.some((m) => m.name.toLowerCase() === pc.name.toLowerCase());
        n++
      )
        pc.name = `${base} ${n}`;
      act(() => {
        party.members.push(pc);
        selected = party.members.length - 1;
        return `Added ${pc.name} to the party.`;
      });
      return pc.name;
    },
    select(name) {
      const i = party.members.findIndex((m) => m.name === name);
      if (i >= 0) selected = i;
      render();
    },
  };
}

/** The whole sheet, gear and notes included, for "Print sheet" only. */
function printable(data: SheetData): HTMLElement {
  const el = h("article", { class: "sheet member-print" });
  renderSheetData(el, data, { reveal: false });
  return el;
}

/** Print the selected member's sheet alone (app.css, body[data-print]). */
function printSheet(): void {
  document.body.dataset.print = "member";
  window.addEventListener("afterprint", () => delete document.body.dataset.print, { once: true });
  window.print();
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty party-empty" },
    h("div", { class: "glyph" }, "[ ]"),
    h("p", { class: "say" }, "No one in the party yet"),
    h(
      "p",
      { class: "sub" },
      "Generate a character, then choose Add to party. Or import a party.json from dw party.",
    ),
  );
}

const hpSaid = (pc: PC): string =>
  `${pc.name}: HP ${pc.hp}/${pc.maxHp}${pc.hp <= 0 ? " (at 0 HP or below)" : ""}`;
const tags = (...parts: (string | null | undefined)[]): string =>
  parts.filter((p) => p).join(" · ");
const list = (title: string, rows: HTMLElement[]): HTMLElement | null =>
  rows.length ? block(title, h("ul", { class: "entries" }, ...rows)) : null;

const SAVE_KEYS = ["doom", "ray", "hold", "blast", "spell"] as const;
const SAVE_LABEL = { doom: "Doom", ray: "Ray", hold: "Hold", blast: "Blast", spell: "Spell" };
const ABILITIES = ["str", "int", "wis", "dex", "con", "cha"] as const;
/** How much of an entry's text its closed line carries (CSS cuts it to fit). */
const TAG_LENGTH = 140;
/** The parts of the view whose fields a change empties. */
const PARTS = "form, .row, .play-strip, .party-bar, .member__block";
const NO_TEXT = "The saved book has no text for this.";

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
