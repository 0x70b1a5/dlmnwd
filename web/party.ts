// The party view: the characters a table is running, and the changes play makes
// to them (XP and levels, HP, gear and encumbrance, coins, runes, glamours,
// knacks, spells, notes). The rules come from the party engine in src/party/,
// the same code `dw party` and `dw pc` run. The party stays in this browser.

import type { Character } from "../src/gen/character.ts";
import {
  allowedCount,
  applyHp,
  findRune,
  forgetName,
  gainsRunesOnLevel,
  learnName,
  type NameList,
} from "../src/party/actions.ts";
import { computeAc, describeLoad } from "../src/party/encumbrance.ts";
import { characterToPc } from "../src/party/from-character.ts";
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
import { h } from "./sheet.ts";

export interface PartyView {
  /** Use the rules from a newly loaded Player's Book. */
  setRules(rules: PartyRules): void;
  /** Add a generated character. Returns the name it was added under. */
  add(character: Character): string;
  /** Select a member by name, for when the view is shown. */
  select(name: string): void;
}

type Message = { text: string; kind: "info" | "error" };

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface PartyHooks {
  /** Hears the member count after each change. */
  onCount(n: number): void;
  /** Show a member's full sheet. */
  onSheet(pc: PC, party: Party, rules: PartyRules): void;
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

  /** Run a change, save, and show its message (or its error). */
  // Undo: the party as it was before each recent change, newest last.
  const history: { label: string; party: string; selected: number }[] = [];
  const HISTORY = 30;

  /** Run a change, save, and show its message (or its error). A change that
   *  fails is rolled back, so a half-made change never stays. */
  function act(change: () => string | void): void {
    const before = JSON.stringify(party);
    const wasSelected = selected;
    try {
      const text = change();
      history.push({ label: text || "the last change", party: before, selected: wasSelected });
      if (history.length > HISTORY) history.shift();
      storedOk = storeParty(party);
      message = text ? { text, kind: "info" } : null;
    } catch (err) {
      party = normalizeParty(JSON.parse(before), "The party");
      selected = wasSelected;
      message = { text: (err as Error).message, kind: "error" };
    }
    render();
  }

  function undo(): void {
    const last = history.pop();
    if (!last) return;
    party = normalizeParty(JSON.parse(last.party), "The party");
    selected = last.selected;
    storedOk = storeParty(party);
    message = { text: `Undone: ${clip(last.label, 90)}`, kind: "info" };
    render();
  }

  function render(): void {
    if (selected >= party.members.length) selected = party.members.length - 1;
    onCount(party.members.length);
    const pc = party.members[selected];
    // Redrawing replaces every control, so keep the focus and scroll position.
    const focus = focusKey(root);
    const scroll = [window.scrollX, window.scrollY] as const;
    root.replaceChildren(
      h(
        "div",
        { class: "party" },
        partyBar(),
        statusLine(),
        party.members.length > 0 ? roster() : emptyState(),
        pc ? member(pc) : null,
      ),
    );
    if (focus) restoreFocus(root, focus);
    window.scrollTo(scroll[0], scroll[1]);
  }

  function statusLine(): HTMLElement {
    const notes: Message[] = [];
    if (message) notes.push(message);
    if (!storedOk)
      notes.push({
        text: "This browser won't save the party. Export it before you close the page.",
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
      ...notes.map((n) => h("p", { class: "status", "data-kind": n.kind }, n.text)),
    );
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

    const file = h("input", { type: "file", accept: "application/json,.json", hidden: "" });
    file.addEventListener("change", () => {
      const f = (file as HTMLInputElement).files?.[0];
      (file as HTMLInputElement).value = "";
      if (!f) return;
      void readPartyFile(f).then(
        (p) => {
          if (party.members.length > 0 && !confirm(`Replace the party with ${f.name}?`)) return;
          act(() => {
            party = p;
            selected = party.members.length > 0 ? 0 : -1;
            return `Imported ${plural(party.members.length, "member")} from ${f.name}.`;
          });
        },
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
            party.day += 1;
            return `Day ${party.day}. Daily rune uses are refreshed.`;
          }),
        ),
      ),
      h("label", { class: "party-bar__group" }, h("span", { class: "label" }, "Encumbrance"), enc),
      h("div", { class: "party-bar__group" }, h("span", { class: "label" }, "Award XP"), award),
      h(
        "div",
        { class: "party-bar__group" },
        button("Export", () => download("party.json", partyJson(party), "application/json")),
        button("Import", () => (file as HTMLInputElement).click()),
        file,
        undoButton(),
      ),
    );
  }

  function roster(): HTMLElement {
    const head = ["Name", "Kindred & Class", "Lvl", "XP", "HP", "AC", "Load", "Speed"];
    const num = [false, false, true, true, true, true, true, true];
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
      const cells = [
        `${pc.level}`,
        `${pc.xp.toLocaleString()}${next !== null ? `/${next.toLocaleString()}` : ""}${canLevel(pc, klass) ? " ★" : ""}`,
        `${pc.hp}/${pc.maxHp}`,
        `${computeAc(pc, rules.catalog)}`,
        party.encumbrance === "slots"
          ? `${load.equippedSlots}+${load.stowedSlots}`
          : party.encumbrance === "basic"
            ? "-"
            : `${load.weight}`,
        load.speed > 0 ? `${load.speed}` : "0 !",
      ];
      return h(
        "tr",
        i === selected ? { class: "is-selected" } : {},
        h("td", {}, pickBtn, load.problems.length ? h("span", { class: "warn" }, " !") : null),
        h("td", {}, kindredClass(pc, rules)),
        ...cells.map((c) => h("td", { class: "num" }, c)),
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
            h("tr", {}, ...head.map((t, k) => h("th", num[k] ? { class: "num" } : {}, t))),
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
    const load = loadOf(pc, party, rules);
    const klass = classOf(rules, pc.class);
    const next = nextLevelXp(pc, klass);
    const mod = xpModifier(pc, rules);
    return h(
      "article",
      { class: "member", "aria-label": pc.name },
      h(
        "header",
        { class: "member__head" },
        h("h2", { class: "sheet-name" }, pc.name),
        h(
          "p",
          { class: "member__sub" },
          `Level ${pc.level} ${kindredClass(pc, rules)}` +
            `${pc.player ? ` · player ${pc.player}` : ""}${pc.status !== "active" ? ` · ${pc.status}` : ""}`,
        ),
      ),
      h(
        "dl",
        { class: "statline member__stats" },
        stat("HP", `${pc.hp}/${pc.maxHp}`),
        stat("AC", `${computeAc(pc, rules.catalog)}`),
        stat("Attack", signed(pc.attack)),
        stat("XP", `${pc.xp.toLocaleString()}${next !== null ? `/${next.toLocaleString()}` : ""}`),
        stat("Speed", load.speed > 0 ? `${load.speed}` : "0"),
        stat("Day", `${party.day}`),
      ),
      h(
        "div",
        { class: "member__grid" },
        block("Hit points", hpBlock(pc)),
        block(`Experience${mod ? ` (${signed(mod)}%)` : ""}`, xpBlock(pc)),
        block("Load", loadBlock(pc), "wide"),
        block("Gear", gearBlock(pc), "wide"),
        block("Coins", coinBlock(pc), "wide"),
        block("Runes", runeBlock(pc)),
        block("Glamours", listBlock(pc, "glamours", rules.glamours)),
        block("Knacks", listBlock(pc, "knacks", rules.knacks)),
        block("Spells", listBlock(pc, "spells", [])),
        block("Notes", notesBlock(pc)),
        block("Character", detailBlock(pc)),
      ),
      h(
        "div",
        { class: "member__foot" },
        button("View full sheet", () => hooks.onSheet(pc, party, rules)),
        button("Download sheet .md", () =>
          download(
            `${safeName(pc.name, "character")}.md`,
            pcMarkdown(pc, party, rules),
            "text/markdown",
          ),
        ),
        button("Remove from party", () => {
          if (!confirm(`Remove ${pc.name} from the party?`)) return;
          act(() => {
            party.members = party.members.filter((m) => m !== pc);
            return `Removed ${pc.name} from the party.`;
          });
        }),
      ),
    );
  }

  function hpBlock(pc: PC): HTMLElement {
    const n = numInput("", { min: "1", placeholder: "N", "aria-label": "Hit points" });
    const amount = (): number => {
      const v = parseInt(n.value, 10);
      if (!(v > 0)) throw new Error("Enter an amount of HP.");
      return v;
    };
    const after = () =>
      `${pc.name}: HP ${pc.hp}/${pc.maxHp}${pc.hp <= 0 ? " (at 0 HP or below)" : ""}`;
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row" },
        n,
        button("Damage", () => act(() => (applyHp(pc, `-${amount()}`), after()))),
        button("Heal", () => act(() => (applyHp(pc, `+${amount()}`), after()))),
        button("Full", () => act(() => (applyHp(pc, "max"), after()))),
      ),
      h(
        "label",
        { class: "row" },
        h("span", { class: "label" }, "Max HP"),
        numInput(`${pc.maxHp}`, { min: "1", "aria-label": "Maximum HP" }, (v) =>
          act(() => {
            pc.maxHp = Math.max(1, v);
            pc.hp = Math.min(pc.hp, pc.maxHp);
          }),
        ),
      ),
    );
  }

  function xpBlock(pc: PC): HTMLElement {
    const klass = classOf(rules, pc.class);
    const next = nextLevelXp(pc, klass);
    const add = numInput("", { min: "1", placeholder: "XP", "aria-label": "XP to add" });
    const hpRoll = numInput("", {
      min: "0",
      placeholder: "roll",
      "aria-label": "Your hit point roll",
    });
    const ready = canLevel(pc, klass);
    const hasTable = !!klass?.advancement?.length;
    const lvl = button(
      ready ? "Level up" : "Level up anyway",
      () => {
        if (!klass) return;
        if (
          !ready &&
          !confirm(`${pc.name} doesn't have the XP for level ${pc.level + 1}. Level up anyway?`)
        )
          return;
        act(() =>
          levelSummary(
            pc,
            levelUp(pc, klass, hpRoll.value ? { hp: parseInt(hpRoll.value, 10) } : {}),
          ),
        );
      },
      ready ? "btn" : "btn ghost",
    );
    if (!hasTable || next === null) (lvl as HTMLButtonElement).disabled = true;
    return h(
      "div",
      { class: "stack" },
      form(
        () =>
          act(() => {
            const v = parseInt(add.value, 10);
            if (!(v > 0)) throw new Error("Enter the XP to add.");
            const a = grantXp(pc, v, rules);
            return `${pc.name} +${a.gained}${a.modifier ? ` (${signed(a.modifier)}%)` : ""} → ${pc.xp.toLocaleString()} XP${a.ready ? " ★ can level up" : ""}`;
          }),
        add,
        button("Add XP", null, "btn ghost", "submit"),
      ),
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
      parts.push(`Add ${want - pc.glamours.length} glamour(s)`);
    if (gainsRunesOnLevel(pc, rules)) parts.push("Roll for a new rune");
    parts.push(`Check the class entry for new spells, skills and traits`);
    return parts.join(" · ");
  }

  function loadBlock(pc: PC): HTMLElement {
    const load = loadOf(pc, party, rules);
    return h(
      "div",
      { class: "stack" },
      h("p", { class: "load-line" }, describeLoad(load)),
      ...load.problems.map((p) => h("p", { class: "status", "data-kind": "error" }, p)),
    );
  }

  function gearBlock(pc: PC): HTMLElement {
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
        h("td", { class: "num" }, itemNum(pc, it, "weight", 0)),
        h("td", { class: "num" }, itemNum(pc, it, "slots", 0)),
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
                  h("th", { class: "num" }, "Coins"),
                  h("th", { class: "num" }, "Slots"),
                  h("th", {}, "Where"),
                  h("th", { class: "num" }, ""),
                ),
              ),
              h("tbody", {}, ...rows),
            ),
          )
        : h("p", { class: "hint" }, "Carrying nothing."),
      addForm,
      h("p", { class: "hint" }, "Coins and slots are per item. Click where an item is to move it."),
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
        "btn mini",
      );
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
          use,
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
        const entry = lookupRune(rules.runes, choose.value);
        if (!choose.value || !entry) throw new Error("Choose a rune to grant.");
        const { rune, duplicate } = grantRune(pc, entry);
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
          const added = learnName(pc, field, known, input.value);
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
    const retainer = h("input", { type: "checkbox" }) as HTMLInputElement;
    retainer.checked = pc.retainer;
    retainer.addEventListener("change", () => act(() => void (pc.retainer = retainer.checked)));
    return h(
      "div",
      { class: "stack" },
      text("Name", "name"),
      text("Player", "player"),
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
    setRules(r) {
      rules = r;
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
      party.members.push(pc);
      selected = party.members.length - 1;
      act(() => `Added ${pc.name} to the party.`);
      return pc.name;
    },
    select(name) {
      const i = party.members.findIndex((m) => m.name === name);
      if (i >= 0) selected = i;
      render();
    },
  };
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

function stat(label: string, value: string): HTMLElement {
  return h("div", {}, h("dt", {}, label), h("dd", {}, value));
}

function block(title: string, body: HTMLElement, size: "wide" | "" = ""): HTMLElement {
  return h(
    "section",
    { class: `member__block${size ? ` member__block--${size}` : ""}` },
    h("h3", {}, title),
    body,
  );
}

function button(
  label: string,
  onClick: (() => void) | null,
  cls = "btn ghost",
  type: "button" | "submit" = "button",
  ariaLabel?: string,
): HTMLElement {
  const b = h(
    "button",
    { type, class: cls, ...(ariaLabel ? { "aria-label": ariaLabel } : {}) },
    label,
  );
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function form(onSubmit: () => void, ...kids: (HTMLElement | null)[]): HTMLElement {
  const f = h("form", { class: "row" }, ...kids);
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  return f;
}

function numInput(
  value: string,
  attrs: Record<string, string>,
  onChange?: (v: number) => void,
): HTMLInputElement {
  const el = h("input", {
    type: "number",
    inputmode: "numeric",
    step: "1",
    value,
    ...attrs,
  }) as HTMLInputElement;
  if (onChange)
    el.addEventListener("change", () => {
      const v = parseInt(el.value, 10);
      if (Number.isFinite(v)) afterFocusMoves(() => onChange(v));
    });
  return el;
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const el = h("input", { type: "text", value }) as HTMLInputElement;
  el.addEventListener("change", () => afterFocusMoves(() => onChange(el.value)));
  return el;
}

function select(
  options: [string, string][],
  value: string,
  onChange?: (v: string) => void,
): HTMLSelectElement {
  const el = h(
    "select",
    {},
    ...options.map(([v, label]) =>
      h("option", v === value ? { value: v, selected: "" } : { value: v }, label),
    ),
  ) as HTMLSelectElement;
  if (onChange) el.addEventListener("change", () => afterFocusMoves(() => onChange(el.value)));
  return el;
}

/**
 * Run a change from a field's change event once the browser has moved focus. A
 * field fires change as Tab leaves it; redrawing at once would replace the
 * control Tab is about to move to, and focus would fall to the page.
 */
function afterFocusMoves(run: () => void): void {
  setTimeout(run, 0);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A name for the focused control that survives a redraw: its block, its kind,
 *  its label, and which of the controls with that name it is. */
function controlKey(el: Element): string {
  const area =
    el.closest(".member__block")?.querySelector("h3")?.textContent ??
    (el.closest(".party-bar") ? "bar" : el.closest(".party-roster") ? "roster" : "");
  const label =
    el.getAttribute("aria-label") ??
    el.getAttribute("placeholder") ??
    (el.tagName === "BUTTON" ? el.textContent : "") ??
    "";
  return `${area}|${el.tagName}|${(el as HTMLInputElement).type ?? ""}|${label}`;
}

const CONTROLS = "input, select, button, textarea";

function focusKey(root: HTMLElement): { key: string; n: number } | null {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.matches(CONTROLS)) return null;
  const key = controlKey(el);
  const same = [...root.querySelectorAll(CONTROLS)].filter((c) => controlKey(c) === key);
  return { key, n: same.indexOf(el) };
}

function restoreFocus(root: HTMLElement, focus: { key: string; n: number }): void {
  const same = [...root.querySelectorAll(CONTROLS)].filter((c) => controlKey(c) === focus.key);
  const el = (same[focus.n] ?? same.at(-1)) as HTMLElement | undefined;
  el?.focus({ preventScroll: true });
}
