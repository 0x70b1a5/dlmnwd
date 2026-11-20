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
  coinsFor,
  learnName,
  type NameList,
  newDay,
  setField,
  shiftCoins,
  ShortOfCoins,
  worthCp,
} from "../src/party/actions.ts";
import {
  addCarrier,
  amountText,
  type At,
  buyCarrier,
  buyItem,
  carrierLoad,
  carrierText,
  coinsLine,
  containerFill,
  contents,
  type Dest,
  destOf,
  groupKey,
  holderOf,
  holdersFor,
  itemById,
  keptText,
  keyText,
  moveItem,
  type PlaceGroup,
  placeGroups,
  placeKey,
  placeText,
  type Purse,
  removeCarrier,
  type Row,
  within,
} from "../src/party/inventory.ts";
import { priceOf, priceText } from "../src/gen/shop.ts";
import type { Transport } from "../src/parse/transport.ts";
import {
  castSpell,
  learnsSpells,
  preparable,
  prepareSpell,
  slotUse,
  traditionSpells,
} from "../src/party/spells.ts";
import { coinCount, computeAc, describeLoad } from "../src/party/encumbrance.ts";
import { characterToPc } from "../src/party/from-character.ts";
import { type ImportResult, pcFromSheet } from "../src/party/import.ts";
import { readFormFields } from "../src/pdf/fields.ts";
import { addItem, dropEntry, makeItem, removeItem, resolveItem } from "../src/party/items.ts";
import {
  COIN_KINDS,
  type Coins,
  emptyCoins,
  ENC_METHODS,
  type EncMethod,
  freshParty,
  normalizeParty,
  stampChanged,
  tidyInventory,
  type InvItem,
  type Party,
  type PC,
} from "../src/party/model.ts";
import { kindredClass, loadOf, pcMarkdown } from "../src/party/render.ts";
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
import { abilityMod, ANIMAL_LOAD } from "../src/rules.ts";
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
  /** Put a party in place of this one with no question (the account's, when this
   *  browser has made no change since). Undo brings this one back. */
  replace(party: Party, said: string): void;
  /** The party as it is now. */
  current(): Party;
}

/** A note under the party bar; `details` lists what a change found on the way. */
type Message = {
  text: string;
  kind: "info" | "error";
  details?: string[];
  /** A button that offers another way to make the change that failed. */
  offer?: Offer;
};
type Offer = { label: string; run: () => void };

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
  /** Hears the party each time a change is saved in this browser. */
  onSave?(party: Party): void;
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
  // True while a change comes from elsewhere (the account), so it is not sent back.
  let quiet = false;
  // The control the user last used, and whether the change it asked for was
  // made. The fields beside it are then empty again on the next draw.
  let used: Element | null = null;
  let changed = false;
  for (const type of ["click", "change", "submit", "keydown"])
    root.addEventListener(type, (e) => void (used = e.target as Element), true);
  // The folds that are open. A redraw builds every fold again, so it reads this.
  const open = new Set<string>();
  // The gear rows and animals open for editing (the pencil), by member and id.
  const edits = new Set<string>();
  // The purse each member pays from, as last chosen in this browser.
  const payFrom = readPayFrom();

  /** Run a change, save, and show its message (or its error). */
  // Undo: the party as it was before each recent change, newest last.
  const history: { label: string; party: string; selected: number }[] = [];
  const HISTORY = 30;

  /** Run a change, save, and show its message (or its error). A change that
   *  fails is rolled back, so a half-made change never stays. `offer` reads the
   *  error, after the roll back, and can give a button that tries another way. */
  function act(
    change: () => string | Message | void,
    offer?: (err: Error) => Offer | undefined,
  ): void {
    const before = JSON.stringify(party);
    const wasSelected = selected;
    try {
      const said = change();
      // Every item and animal keeps an id, whatever made it.
      for (const m of party.members) tidyInventory(m);
      if (!quiet) stampChanged(JSON.parse(before), party, Date.now());
      const note = typeof said === "string" ? { text: said, kind: "info" as const } : said;
      history.push({
        label: note?.text || "the last change",
        party: before,
        selected: wasSelected,
      });
      if (history.length > HISTORY) history.shift();
      storedOk = storeParty(party);
      if (!quiet) hooks.onSave?.(party);
      message = note?.text ? note : null;
      changed = true;
    } catch (err) {
      party = normalizeParty(JSON.parse(before), "The party");
      selected = wasSelected;
      message = { text: (err as Error).message, kind: "error", offer: offer?.(err as Error) };
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
    hooks.onSave?.(party);
    message = { text: `Undone: ${clip(last.label, 90)}`, kind: "info" };
    hooks.onNote?.(message.text, "info");
    render();
  }

  function render(): void {
    // Not under a drag in progress: the rows it measured would move.
    if (drag?.on) {
      drawLater = true;
      return;
    }
    drawLater = false;
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
        h(
          "p",
          {
            // On a phone the strip shows the error instead (stripNote).
            class:
              n === message && n.kind === "error" && party.members[selected]
                ? "status in-strip"
                : "status",
            "data-kind": n.kind,
          },
          n.text,
          n.offer ? offerButton(n.offer) : null,
        ),
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
    const head = ["Name", "Kindred & Class", "Lvl", "XP", "HP", "AC", "Load", "Spd"];
    // `slim`: dropped on the narrowest screens too (the strip shows the AC).
    const cls = ["", "opt", "num", "num opt", "num", "num slim", "num opt", "num"];
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
          pc.carriers.length || rules.transport.length
            ? block("Animals and vehicles", carrierBlock(pc))
            : null,
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
      stripNote(),
    );
  }

  /** The last change's error in the strip, which stays in view as the page
   *  scrolls. Only a narrow screen shows it (app.css); a wide one shows the
   *  status line at the top. */
  function stripNote(): HTMLElement | null {
    if (message?.kind !== "error") return null;
    return h(
      "p",
      { class: "strip-note status", "data-kind": "error", role: "alert" },
      h("span", {}, message.text),
      message.offer ? offerButton(message.offer) : null,
      button(
        "×",
        () => {
          message = null;
          render();
        },
        "btn mini",
        "button",
        "Dismiss the error",
      ),
    );
  }

  /** The purse a member pays from: the one last chosen, while it holds anything. */
  function payOf(pc: PC): Purse {
    return payFrom[pc.name] === "banked" && worthCp(pc.banked) > 0 ? "banked" : "coins";
  }

  /** "Pay from" for a member with coins in the bank. The choice is kept. */
  function purseSelect(pc: PC): HTMLSelectElement | null {
    if (worthCp(pc.banked) === 0) return null;
    const el = select(
      [
        ["coins", "pay from carried"],
        ["banked", "pay from banked"],
      ],
      payOf(pc),
      (v) => {
        payFrom[pc.name] = v as Purse;
        storePayFrom(payFrom);
        render();
      },
    );
    el.setAttribute("aria-label", "Pay from");
    return el;
  }

  /**
   * Buy for the selected member from a purse. When the coins carried are too
   * few and the bank holds enough, the error offers to pay from the bank. The
   * party is rolled back after an error, so `buy` gets the member to change.
   */
  function buyFrom(from: Purse, buy: (pc: PC, from: Purse) => string, formClass: string): void {
    const who = party.members[selected].name;
    act(
      () => buy(party.members[selected], from),
      (err) => {
        const pc = party.members.find((m) => m.name === who);
        if (!(err instanceof ShortOfCoins) || from !== "coins" || !pc) return undefined;
        if (worthCp(pc.banked) < err.cp) return undefined;
        return {
          label: `Pay ${coinsLine(coinsFor(err.cp))} from the bank`,
          run: () => {
            // The form's fields are spent, as when its own button worked.
            used = root.querySelector(`form.${formClass}`);
            buyFrom("banked", buy, formClass);
          },
        };
      },
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

  /** The member's gear by place: equipped, stowed, on each animal or vehicle,
   *  stashed. A row drags by its grip: onto a heading to move it there,
   *  between two rows to put it there, onto an item to put it inside. */
  function gearBlock(pc: PC): HTMLElement {
    const load = loadOf(pc, party, rules);
    // Only the number the party's encumbrance method counts gets a column.
    const measure: "weight" | "slots" | null =
      party.encumbrance === "weight" ? "weight" : party.encumbrance === "slots" ? "slots" : null;
    const cols = measure ? 4 : 3;
    const body: HTMLElement[] = [];
    for (const g of placeGroups(pc)) {
      const shown = g.rows.length > 0 || !!g.carrier;
      body.push(
        h(
          "tr",
          {
            class: `grp${shown ? "" : " empty"}${g.carrier ? " carrier" : ""}`,
            "data-drop": g.key,
          },
          h("td", { colspan: `${cols}` }, ...groupHead(pc, g, load)),
        ),
      );
      // After a container's contents, a strip to drop into it at the end
      // (shown while dragging).
      const boxes: Row[] = [];
      const close = (depth: number): void => {
        while (boxes.length && boxes[boxes.length - 1].depth >= depth) {
          const box = boxes.pop()!;
          body.push(
            h(
              "tr",
              { class: "cend", "data-into": box.item.id!, style: `--depth:${box.depth + 1}` },
              h("td", { colspan: `${cols}` }, h("span", {}, `into ${box.item.name}, at the end`)),
            ),
          );
        }
      };
      for (const r of g.rows) {
        close(r.depth);
        body.push(itemRow(pc, r, measure));
        if (contents(pc, r.item).length) boxes.push(r);
      }
      close(0);
    }

    return h(
      "div",
      { class: "stack" },
      h("p", { class: "load-line" }, describeLoad(load)),
      ...load.problems.map((p) => h("p", { class: "status", "data-kind": "error" }, p)),
      pc.items.length || pc.carriers.length
        ? h(
            "table",
            { class: "gear" },
            h(
              "colgroup",
              {},
              h("col", {}),
              h("col", { class: "c-q" }),
              measure ? h("col", { class: "c-w" }) : null,
              h("col", { class: "c-x" }),
            ),
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
                h("th", {}, ""),
              ),
            ),
            h("tbody", {}, ...body),
          )
        : h("p", { class: "hint" }, "Carrying nothing."),
      addItemForm(pc),
      h(
        "p",
        { class: "hint" },
        measure ? `${measure === "weight" ? "Coins" : "Slots"} are per item. ` : "",
        "Drag ⠿ onto a heading, between rows, or onto a container. ",
        "The pencil moves or removes an item. Stashed items count for nothing.",
      ),
    );
  }

  /** A place's heading: its name, and its load where the method counts one. */
  function groupHead(
    pc: PC,
    g: PlaceGroup,
    load: ReturnType<typeof loadOf>,
  ): (HTMLElement | string | null)[] {
    const slots = party.encumbrance === "slots";
    const weight = ` · ${amountText(
      g.rows.reduce((n, r) => n + r.item.qty * r.item.weight, 0),
      "coins",
    )}`;
    const empty = g.rows.length ? null : sub(" · drop here");
    if (g.carrier) {
      const c = g.carrier;
      const l = carrierLoad(pc, c, party.encumbrance, rules.enc);
      const of = `${l.used.toLocaleString("en")} of ${amountText(l.capacity, l.unit)}`;
      const said =
        l.state === "normal"
          ? of
          : l.state === "slow"
            ? `${of}: half Speed (most ${l.most.toLocaleString("en")})`
            : `${amountText(l.used, l.unit)}: over the most it carries, ${l.most.toLocaleString("en")}`;
      return [
        `On ${c.name}`,
        c.name !== c.type ? sub(` ${c.type}`) : null,
        sub(` · ${said}`, `load ${l.state}`),
        l.speed !== undefined ? sub(` · Speed ${l.speed}`) : null,
        g.rows.length ? null : sub(" · nothing on it"),
      ];
    }
    if (g.where === "equipped") {
      const max = rules.enc.slots.at(-1)?.equipped;
      return [
        "Equipped",
        slots && max ? sub(` · ${load.equippedSlots} of ${max} slots`) : slots ? null : sub(weight),
        empty,
      ];
    }
    if (g.where === "stowed")
      return [
        "Stowed",
        slots
          ? sub(` · ${load.stowedSlots} of ${load.stowedCapacity} slots, coins too`)
          : sub(weight),
        empty,
      ];
    return ["Stashed", g.kept ? sub(` ${keptText(g.kept)}`) : null, sub(" · not carried"), empty];
  }

  function itemRow(pc: PC, r: Row, measure: "weight" | "slots" | null): HTMLElement {
    const it = r.item;
    const fill = containerFill(pc, it, party.encumbrance, rules.enc, rules.catalog);
    const grip = h(
      "span",
      {
        class: "grip",
        "data-grip": it.id!,
        title: "Drag onto a heading, between two rows, or onto an item to put it inside",
        "aria-hidden": "true",
      },
      "⠿",
    );
    const id = it.id!;
    on(grip, "pointerdown", (e) => startDrag(e as PointerEvent, id));
    const key = editKey(pc, id);
    const editing = edits.has(key);
    const cls = [
      it.where === "stashed" || it.where === "loaded" ? "off" : "",
      editing ? "editing" : "",
    ].filter(Boolean);
    return h(
      "tr",
      { "data-item": id, ...(cls.length ? { class: cls.join(" ") } : {}) },
      h(
        "td",
        { class: "item", style: `--depth:${r.depth}` },
        h(
          "div",
          { class: "iline" },
          grip,
          h(
            "span",
            { class: "iname", title: it.name },
            it.name,
            it.note ? h("span", { class: "muted" }, ` (${it.note})`) : null,
            it.treasure ? h("span", { class: "tag" }, "treasure") : null,
            it.bulky ? h("span", { class: "tag" }, "bulky") : null,
            it.ref && it.ref !== it.name ? h("span", { class: "muted" }, ` = ${it.ref}`) : null,
          ),
        ),
        fill
          ? h(
              "span",
              { class: `fill${fill.used > fill.capacity ? " over" : ""}` },
              `${fill.used.toLocaleString("en")} of ${amountText(fill.capacity, fill.unit)} in it`,
            )
          : null,
        editing
          ? h(
              "div",
              { class: "imeta" },
              whereSelect(pc, it),
              it.where === "stashed" && !it.in ? keptInput(pc, it) : null,
              button(
                "Remove",
                () => act(() => (removeItem(pc, it), `${pc.name} drops ${it.name}`)),
                "linkish",
                "button",
                `Remove all ${it.name}`,
              ),
            )
          : null,
      ),
      h("td", { class: "num" }, itemNum(pc, it, "qty", 0)),
      measure ? h("td", { class: "num" }, itemNum(pc, it, measure, 0)) : null,
      h(
        "td",
        { class: "x" },
        button(
          "−1",
          () => act(() => (removeItem(pc, it, 1), `${pc.name} −1 ${it.name}`)),
          "btn mini",
          "button",
          `Remove one ${it.name}`,
        ),
        editToggle(key, it.name, "where it is, or Remove"),
      ),
    );
  }

  /** The pencil that opens a row's edit line, and the check that closes it. */
  function editToggle(key: string, name: string, what: string): HTMLElement {
    const editing = edits.has(key);
    const b = h("button", {
      type: "button",
      class: `iedit${editing ? " on" : ""}`,
      title: editing ? "Done" : `Edit: ${what}`,
      "aria-label": `${editing ? "Done editing" : "Edit"} ${name}`,
      "aria-pressed": `${editing}`,
    });
    on(b, "click", () => {
      if (!edits.delete(key)) edits.add(key);
      render();
    });
    return b;
  }

  /** The places an item can be: on the character, on each animal or vehicle,
   *  stashed, or inside one of the containers. */
  function placeOptions(pc: PC, it: InvItem | null): [string, string][] {
    const boxes = holdersFor(pc, it, rules.catalog);
    const count = (n: string): number => boxes.filter((b) => b.name === n).length;
    return [
      ["equipped", "equipped"],
      ["stowed", "stowed"],
      ...pc.carriers.map((c): [string, string] => [`on:${c.id}`, `on ${c.name}`]),
      ["stashed", "stashed"],
      ...boxes.map((b): [string, string] => [
        `in:${b.id}`,
        `in ${b.name}${count(b.name) > 1 ? ` (${placeText(pc, b)})` : ""}`,
      ]),
    ];
  }

  /** Where an item is. Choosing a place takes it out of any container. */
  function whereSelect(pc: PC, it: InvItem): HTMLSelectElement {
    const el = select(placeOptions(pc, it), placeKey(it), (v) =>
      act(() => `${pc.name}: ${moveItem(pc, it, destOf(v), rules.enc)}`),
    );
    el.setAttribute("aria-label", `Where ${it.name} is`);
    el.classList.add("where");
    if (it.where === "stashed") el.dataset.stashed = "";
    return el;
  }

  /** Where a stashed item is kept: the items stashed at one place are listed together. */
  function keptInput(pc: PC, it: InvItem): HTMLInputElement {
    const el = textInput(it.kept ?? "", (v) =>
      act(() => {
        const kept = v.trim();
        return `${pc.name}: ${moveItem(pc, it, kept ? { where: "stashed", kept } : { where: "stashed" }, rules.enc)}`;
      }),
    );
    el.placeholder = "where? (at the inn)";
    el.setAttribute("aria-label", `Where ${it.name} is kept`);
    el.classList.add("kept");
    return el;
  }

  /** Add an item (found, given, already owned) or buy it at the book's price. */
  function addItemForm(pc: PC): HTMLElement {
    const listId = "catalog-items";
    const name = h("input", {
      type: "text",
      list: listId,
      placeholder: rules.catalog.length ? "item, from the book's lists" : "item",
      "aria-label": "Item to add",
    }) as HTMLInputElement;
    const qty = numInput("", { min: "1", placeholder: "qty", "aria-label": "Quantity" });
    const where = select([["", "auto"], ...placeOptions(pc, null)], "");
    where.setAttribute("aria-label", "Where it goes");
    const purse = purseSelect(pc);
    const names = [
      ...new Set([...rules.catalog.map((c) => c.name), ...rules.transport.map((t) => t.name)]),
    ];
    const add = (buying: boolean): void => {
      const text = name.value.trim();
      const n = qty.value ? parseInt(qty.value, 10) : undefined;
      const to = where.value ? destOf(where.value) : undefined;
      // An animal or vehicle named here joins the list of them.
      const found = rules.transport.find((x) => x.name.toLowerCase() === text.toLowerCase());
      const t = found && !resolveItem(rules.catalog, text).item ? found : undefined;
      if (buying)
        return buyFrom(
          (purse?.value as Purse | undefined) ?? payOf(pc),
          (m, from) => {
            if (!text) throw new Error("Name the item to buy.");
            if (t) return buyCarrier(m, t, { purse: from }).line;
            return buyItem(m, rules, text, { qty: n, to, purse: from }).line;
          },
          "add-item",
        );
      act(() => {
        if (!text) throw new Error("Name the item to add.");
        if (t) return `${pc.name} +${carrierText(addCarrier(pc, t))}`;
        const { inv, resolved } = makeItem(rules.catalog, rules.enc, text, { qty: n });
        if (to) moveItem(pc, inv, to, rules.enc);
        const stacked = addItem(pc, inv);
        const said = resolved.item
          ? `${resolved.item.name}: ${inv.weight} coins${inv.qty > 1 ? " each" : ""}, ${plural(inv.slots, "slot")}`
          : `not in the book's lists: weight ${inv.weight}, set it in the table`;
        return `${pc.name} +${inv.qty} ${inv.name} → ${placeText(pc, stacked)} [${said}]${stacked.qty !== inv.qty ? ` (now ×${stacked.qty})` : ""}`;
      });
    };
    const f = form(
      () => add(false),
      name,
      qty,
      where,
      button("Add", null, "btn", "submit"),
      button("Buy", () => add(true), "btn ghost", "button", "Buy it at the book's price"),
      purse,
      h("datalist", { id: listId }, ...names.map((n) => h("option", { value: n }))),
    );
    f.classList.add("add-item");
    return f;
  }

  /** The member's animals and vehicles, and buying or adding one from the book's list. */
  function carrierBlock(pc: PC): HTMLElement {
    const rows = pc.carriers.map((c) => {
      const t = rules.transport.find((x) => x.name === c.type);
      const l = carrierLoad(pc, c, party.encumbrance, rules.enc);
      const key = editKey(pc, c.id);
      const editing = edits.has(key);
      const facts = [
        c.name !== c.type ? c.type : "",
        t?.type && t.type !== c.type ? t.type : "",
        t?.ac ? `AC ${t.ac}` : "",
        t?.hp ? `HP ${t.hp}` : "",
        c.speed !== undefined ? `Speed ${c.speed}` : "",
        ...Object.entries(t?.more ?? {}).map(([k, v]) => `${k}: ${v}`),
        c.kind === "animal"
          ? `carries ${c.load.toLocaleString("en")}, ${(c.load * ANIMAL_LOAD.halfSpeedTimes).toLocaleString("en")} at half Speed`
          : `carries ${c.load.toLocaleString("en")}`,
      ].filter(Boolean);
      const rename = textInput(c.name, (v) =>
        act(() => {
          const was = c.name;
          c.name = v.trim() || c.type;
          return `${pc.name}: ${was} is now ${c.name}`;
        }),
      );
      rename.setAttribute("aria-label", `Name of ${c.name}`);
      return h(
        "li",
        { class: `carrier${editing ? " editing" : ""}` },
        h(
          "div",
          { class: "cline" },
          h(
            "span",
            { class: "cwho" },
            h("b", {}, c.name),
            " ",
            h("span", { class: "facts" }, facts.join(" · ")),
            l.state !== "normal"
              ? h(
                  "span",
                  { class: `load ${l.state}` },
                  l.state === "slow" ? " half Speed" : " over",
                )
              : null,
          ),
          editToggle(key, c.name, "its name, its load, or Remove"),
        ),
        editing
          ? h(
              "div",
              { class: "imeta" },
              rename,
              h(
                "label",
                { class: "carries" },
                "carries ",
                numInput(
                  `${c.load}`,
                  { min: "0", class: "cell", "aria-label": `Coins ${c.name} carries` },
                  (v) => act(() => void (c.load = Math.max(0, v))),
                ),
                " coins",
              ),
              button(
                "Remove",
                () => act(() => removeCarrier(pc, c)),
                "linkish",
                "button",
                `Remove ${c.name}`,
              ),
            )
          : null,
      );
    });
    const list = rules.transport;
    const sections = [...new Set(list.map((t) => t.section))];
    const pick = h(
      "select",
      { "aria-label": "Animal or vehicle" },
      ...sections.map((s) =>
        h(
          "optgroup",
          { label: titleCase(s) || "Animals and vehicles" },
          ...list
            .filter((t) => t.section === s)
            .map((t) =>
              h(
                "option",
                { value: t.name },
                `${t.name} — ${transportPrice(t)}, carries ${t.load.toLocaleString("en")}`,
              ),
            ),
        ),
      ),
    ) as HTMLSelectElement;
    const named = h("input", {
      type: "text",
      placeholder: "name (optional)",
      "aria-label": "Its name",
    }) as HTMLInputElement;
    const purse = purseSelect(pc);
    const get = (buying: boolean): void => {
      const t = list.find((x) => x.name === pick.value);
      const name = named.value.trim() || undefined;
      if (buying)
        return buyFrom(
          (purse?.value as Purse | undefined) ?? payOf(pc),
          (m, from) => {
            if (!t) throw new Error("Choose an animal or vehicle.");
            return buyCarrier(m, t, { name, purse: from }).line;
          },
          "add-carrier",
        );
      act(() => {
        if (!t) throw new Error("Choose an animal or vehicle.");
        return `${pc.name} +${carrierText(addCarrier(pc, t, name))}, not paid for`;
      });
    };
    const f = list.length
      ? form(
          () => get(true),
          pick,
          named,
          button("Buy", null, "btn", "submit"),
          button("Add", () => get(false), "btn ghost", "button", "Add it without paying"),
          purse,
        )
      : null;
    f?.classList.add("add-carrier");
    return h(
      "div",
      { class: "stack" },
      rows.length
        ? h("ul", { class: "carriers" }, ...rows)
        : h("p", { class: "hint" }, "No animals or vehicles."),
      f,
      h(
        "p",
        { class: "hint" },
        list.length
          ? "Each one is a place in the gear above: what is on it counts toward its load, not the character's."
          : "The saved book has no list of animals or vehicles. Load the PDF again.",
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
            dropEntry(pc, it);
            return `${pc.name} drops ${it.name}`;
          }
        }),
    );
  }

  // The drag in progress, and whether a draw waits for it to end.
  let drag: Drag | null = null;
  let drawLater = false;

  function startDrag(e: PointerEvent, id: string): void {
    const pc = party.members[selected];
    const it = pc && itemById(pc, id);
    if (!it || e.button > 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const shown = placeGroups(pc).flatMap((g) =>
      g.rows.map((r) => ({ id: r.item.id!, depth: r.depth })),
    );
    drag = {
      id,
      member: selected,
      x: e.clientX,
      y: e.clientY,
      on: false,
      below: new Set([...within(pc, it)].map((i) => i.id!)),
      shown,
      pos: new Map(shown.map((r, k) => [r.id, k])),
      target: null,
      row: grip.closest("tr"),
      table: grip.closest("table"),
    };
  }

  /** The drop under the pointer: a heading, the strip at a container's end,
   *  the gap above or below a row, or the middle of a row (into that item). */
  function dropAt(d: Drag, x: number, y: number): Drop | null {
    const pc = party.members[d.member];
    const it = pc && itemById(pc, d.id);
    const el = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("tr[data-item], tr[data-drop], tr[data-into]");
    if (!it || !el || !root.contains(el)) return null;
    const { drop, into } = el.dataset;
    if (drop) {
      if (!it.in && groupKey(it) === drop) return null;
      return { el, kind: "on", to: destOf(drop), label: keyText(pc, drop) };
    }
    if (into) {
      const box = itemById(pc, into);
      if (!box || d.below.has(into)) return null;
      return { el, kind: "on", to: { in: into }, at: { last: true }, label: `in ${box.name}` };
    }
    const target = itemById(pc, el.dataset.item);
    const k = d.pos.get(el.dataset.item ?? "");
    if (!target || k === undefined) return null;
    const r = el.getBoundingClientRect();
    const edge = Math.max(6, Math.min(12, r.height * 0.28));
    if (y < r.top + edge || y > r.bottom - edge) {
      let ref = d.shown[k];
      let after = y > r.bottom - edge;
      const next = d.shown[k + 1];
      // Below a container whose contents follow: first inside it.
      if (after && next && next.depth > ref.depth) {
        ref = next;
        after = false;
      }
      if (d.below.has(ref.id)) return null;
      const o = itemById(pc, ref.id)!;
      const box = holderOf(pc, o);
      const key = box ? `in:${box.id}` : groupKey(o);
      return {
        el,
        kind: after ? "gap-bottom" : "gap-top",
        depth: ref.depth,
        to: destOf(key),
        at: after ? { after: o.id } : { before: o.id },
        label: keyText(pc, key),
      };
    }
    if (d.below.has(target.id!) || it.in === target.id) return null;
    return {
      el,
      kind: "on",
      to: { in: target.id! },
      at: { last: true },
      label: `in ${target.name}`,
    };
  }

  function moveDrag(e: PointerEvent): void {
    const d = drag;
    if (!d) return;
    const pc = party.members[d.member];
    const name = (pc && itemById(pc, d.id)?.name) ?? "";
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.on = true;
      d.ghost = h("div", { class: "drag-ghost" }, name);
      document.body.append(d.ghost);
      document.body.classList.add("dragging");
      d.table?.classList.add("dragging");
      d.row?.classList.add("drag-src");
    }
    d.ghost!.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    const t = dropAt(d, e.clientX, e.clientY);
    if (t?.el !== d.target?.el || t?.kind !== d.target?.kind || t?.depth !== d.target?.depth) {
      markDrop(d.target, false);
      markDrop(t, true);
      d.ghost!.textContent = name + (t ? ` → ${t.label}` : "");
    }
    d.target = t;
    d.ghost!.classList.toggle("none", !t);
    // Near the top or bottom of the window, scroll (a long list on a phone).
    if (e.clientY < 60) scrollBy(0, -14);
    else if (e.clientY > innerHeight - 60) scrollBy(0, 14);
  }

  function endDrag(dropped: boolean): void {
    const d = drag;
    if (!d) return;
    drag = null;
    d.ghost?.remove();
    document.body.classList.remove("dragging");
    markDrop(d.target, false);
    d.table?.classList.remove("dragging");
    d.row?.classList.remove("drag-src");
    const t = d.target;
    if (dropped && d.on && t)
      act(() => {
        const pc = party.members[d.member];
        const it = pc && itemById(pc, d.id);
        if (!it) throw new Error("That item is gone from the list.");
        const ref = (id: string | undefined): InvItem | undefined => itemById(pc, id);
        const at: At | undefined = !t.at
          ? undefined
          : t.at.last
            ? { last: true }
            : t.at.before && ref(t.at.before)
              ? { before: ref(t.at.before)! }
              : t.at.after && ref(t.at.after)
                ? { after: ref(t.at.after)! }
                : undefined;
        return `${pc.name}: ${moveItem(pc, it, t.to, rules.enc, at)}`;
      });
    else if (drawLater) render();
  }

  document.addEventListener("pointermove", (e) => moveDrag(e));
  document.addEventListener("pointerup", () => endDrag(true));
  document.addEventListener("pointercancel", () => endDrag(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) endDrag(false);
  });

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
    // Fields for coins to add, take away, bank or withdraw.
    const amounts = COIN_KINDS.map((k) =>
      numInput("", {
        min: "0",
        class: "cell",
        placeholder: k,
        "aria-label": `${k} to add or move`,
      }),
    );
    const read = (): Coins => {
      const c = emptyCoins();
      COIN_KINDS.forEach((k, i) => {
        const v = amounts[i].value.trim();
        c[k] = v === "" ? 0 : Number(v);
      });
      return c;
    };
    const shift = (from: Purse | null, to: Purse | null, verb: string) => () =>
      act(() => {
        const n = shiftCoins(
          read(),
          from ? pc[from] : null,
          to ? pc[to] : null,
          from === "banked" ? "the bank" : "the coins carried",
        );
        return `${pc.name} ${verb} ${coinsLine(n)}`;
      });
    const carried = coinCount(pc.coins);
    const per = rules.enc.coinsPerSlot || 100;
    const weight =
      party.encumbrance === "slots"
        ? `${plural(Math.ceil(carried / per), "stowed slot")}`
        : `${amountText(carried, "coins")} of weight`;
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
          h(
            "tfoot",
            {},
            h("tr", {}, h("th", {}, "Coins"), ...amounts.map((a) => h("td", { class: "num" }, a))),
          ),
        ),
      ),
      h(
        "div",
        // Not a .row: a change sent from here empties the fields above too.
        { class: "coin-moves" },
        h(
          "span",
          { class: "pair" },
          button(
            "Add",
            shift(null, "coins", "gains"),
            "btn ghost",
            "button",
            "Add these to the coins carried",
          ),
          button(
            "Remove",
            shift("coins", null, "spends"),
            "btn ghost",
            "button",
            "Take these from the coins carried",
          ),
        ),
        h(
          "span",
          { class: "pair" },
          button(
            "Bank",
            shift("coins", "banked", "banks"),
            "btn ghost",
            "button",
            "Move these from the coins carried to the bank",
          ),
          button(
            "Withdraw",
            shift("banked", "coins", "withdraws"),
            "btn ghost",
            "button",
            "Move these from the bank to the coins carried",
          ),
        ),
      ),
      h(
        "p",
        { class: "hint" },
        `Carried: worth ${coinsLine(coinsFor(worthCp(pc.coins)))}, ${weight}. `,
        `Banked: worth ${coinsLine(coinsFor(worthCp(pc.banked)))}, not carried.`,
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
    replace(p, said) {
      quiet = true;
      try {
        act(() => {
          party = p;
          selected = party.members.length > 0 ? 0 : -1;
          return { text: said, kind: "info", details: repairParty(party, rules) };
        });
      } finally {
        quiet = false;
      }
    },
    current: () => party,
    setRules(r) {
      rules = r;
      // Members saved with no Save Targets take them from the book's tables.
      const fixed = repairParty(party, rules);
      if (fixed.length > 0) {
        storedOk = storeParty(party);
        hooks.onSave?.(party);
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
/** A heading's quieter part: " · 3 of 10 slots". */
const sub = (t: string, cls = ""): HTMLElement =>
  h("span", { class: `sub${cls ? ` ${cls}` : ""}` }, t);

/** An animal's or vehicle's price, as the book lists it. */
function transportPrice(t: Transport): string {
  const p = priceOf(t.cost);
  return p ? priceText(p) : "no price";
}

/** Where a dragged item would go, and the row that shows it. */
interface Drop {
  el: HTMLElement;
  /** Onto a row or heading, or into the gap above or below a row. */
  kind: "on" | "gap-top" | "gap-bottom";
  /** A gap's level: how deep in containers the item goes. */
  depth?: number;
  to: Dest;
  /** Ids of the item to go before or after, or last in its place. */
  at?: { before?: string; after?: string; last?: true };
  label: string;
}

/** An item dragged by its grip: pointer events, so a finger drags too. */
interface Drag {
  id: string;
  member: number;
  x: number;
  y: number;
  /** Moved far enough to be a drag, not a tap. */
  on: boolean;
  /** Ids of the item and what is in it: it can't go into them. */
  below: Set<string>;
  /** The rows as drawn when the drag began, for the level of a gap. */
  shown: { id: string; depth: number }[];
  pos: Map<string, number>;
  target: Drop | null;
  ghost?: HTMLElement;
  row: HTMLElement | null;
  table: HTMLElement | null;
}

function markDrop(t: Drop | null, shown: boolean): void {
  if (!t) return;
  if (t.kind === "on") {
    t.el.classList.toggle("drop-on", shown);
    return;
  }
  t.el.classList.toggle("drop-gap", shown);
  t.el.classList.toggle(t.kind, shown);
  if (shown) t.el.style.setProperty("--drop-depth", `${t.depth ?? 0}`);
  else t.el.style.removeProperty("--drop-depth");
}

/** "LAND CARTS" → "Land carts". */
/** The button of a message's offer (`Message.offer`). */
function offerButton(o: Offer): HTMLElement {
  return button(o.label, o.run, "btn mini accent offer");
}

const PAY_KEY = "dlmnwd:pay-from";

/** The purse each member pays from, by name, as kept in this browser. */
function readPayFrom(): Record<string, Purse> {
  try {
    const raw = JSON.parse(localStorage.getItem(PAY_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, Purse] => e[1] === "banked" || e[1] === "coins",
      ),
    );
  } catch {
    return {};
  }
}

function storePayFrom(pay: Record<string, Purse>): void {
  try {
    localStorage.setItem(PAY_KEY, JSON.stringify(pay));
  } catch {
    // Private mode or full storage: the choice lasts until the page closes.
  }
}

/** A gear row's or an animal's key in the set of those open for editing. */
const editKey = (pc: PC, id: string): string => `${pc.name}\n${id}`;

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

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
