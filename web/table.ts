// The Table tab: the referee's tools during play. Dice, reaction and morale
// rolls, side initiative, the wandering check, the dungeon turn clock, and a
// lookup of spells, glamours, knacks and runes in the saved book. The rolls and
// rules are the CLI's own (dw roll, react, morale, init, wander, turn).
//
// The view is built once. A roll only adds to the log and the clock only redraws
// its own lines, so the field in use keeps the focus.

import { roll } from "../src/dice.ts";
import { initLines } from "../src/initiative.ts";
import { moraleBreaks, reaction } from "../src/rules.ts";
import {
  advance,
  formatElapsed,
  freshState,
  parseTurns,
  readTurnState,
  type TurnState,
} from "../src/turn-clock.ts";
import { type Book, bookRules } from "./book.ts";
import { castingEntry, h, traitParagraph } from "./sheet.ts";
import { block, button, form, numInput } from "./ui.ts";

export interface TableView {
  /** Use the saved book for the lookup (null when it is forgotten). */
  setBook(book: Book | null): void;
}

const TURN_KEY = "dlmnwd:turn";
const LOG_SIZE = 60;

function loadTurns(): TurnState {
  try {
    return readTurnState(JSON.parse(localStorage.getItem(TURN_KEY) ?? "null")) ?? freshState();
  } catch {
    return freshState();
  }
}

function saveTurns(state: TurnState): void {
  try {
    localStorage.setItem(TURN_KEY, JSON.stringify(state));
  } catch {}
}

const signed = (n: number): string => (n > 0 ? ` +${n}` : n < 0 ? ` ${n}` : "");
const plural = (n: number, word: string, many = `${word}s`): string =>
  `${n} ${n === 1 ? word : many}`;

function text(attrs: Record<string, string>): HTMLInputElement {
  return h("input", { type: "text", ...attrs }) as HTMLInputElement;
}

function intOf(el: HTMLInputElement, fallback: number): number {
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? v : fallback;
}

/** Show the table tools in `root`. */
export function mountTable(root: HTMLElement): TableView {
  let book: Book | null = null;

  // ── the log: newest first ──
  const log = h("ol", { class: "table-log", "aria-live": "polite" });
  function say(title: string, result: string, detail = "", kind: "" | "hit" | "miss" = ""): void {
    const li = h(
      "li",
      kind ? { "data-kind": kind } : {},
      h("span", { class: "log-title" }, title),
      h("span", { class: "log-result" }, result),
      detail ? h("span", { class: "muted" }, detail) : null,
    );
    log.prepend(li);
    while (log.children.length > LOG_SIZE) log.lastElementChild?.remove();
  }
  function fail(err: unknown): void {
    say("Error", (err as Error).message, "", "miss");
  }
  const logBlock = block(
    "Log",
    h(
      "div",
      { class: "stack" },
      log,
      h(
        "div",
        { class: "row" },
        button("Clear log", () => log.replaceChildren(), "btn mini"),
      ),
    ),
    "wide",
  );

  // ── dice ──
  const expr = text({ placeholder: "3d6+1", "aria-label": "Dice", value: "1d20" });
  const rollExpr = (e: string): void => {
    try {
      const r = roll(e);
      say(`Roll ${e}`, String(r.total), r.rolls.length > 1 ? `(${r.rolls.join(", ")})` : "");
    } catch (err) {
      fail(err);
    }
  };
  const dice = block(
    "Dice",
    h(
      "div",
      { class: "stack" },
      form(
        () => rollExpr(expr.value.trim() || "1d20"),
        expr,
        button("Roll", null, "btn", "submit"),
      ),
      h(
        "div",
        { class: "row" },
        ...[4, 6, 8, 10, 12, 20, 100].map((n) =>
          button(`d${n}`, () => rollExpr(`1d${n}`), "btn mini"),
        ),
      ),
    ),
  );

  // ── reaction ──
  const reactMod = numInput("0", { "aria-label": "Reaction modifier" });
  const react = block(
    "Reaction",
    form(
      () => {
        const mod = intOf(reactMod, 0);
        const r = roll("2d6");
        const total = r.total + mod;
        say("Reaction", `${total}: ${reaction(total)}`, `(2d6=${r.rolls.join("+")}${signed(mod)})`);
      },
      h("label", { class: "field" }, h("span", { class: "label" }, "Modifier"), reactMod),
      button("Roll 2d6", null, "btn", "submit"),
    ),
  );

  // ── morale ──
  const moraleScore = numInput("7", { min: "2", max: "12", "aria-label": "Morale score" });
  const moraleMod = numInput("0", { "aria-label": "Morale modifier" });
  const morale = block(
    "Morale",
    form(
      () => {
        const ml = intOf(moraleScore, NaN);
        if (!Number.isFinite(ml)) return fail(new Error("Enter a morale score (2–12)."));
        const mod = intOf(moraleMod, 0);
        const r = roll("2d6");
        const total = r.total + mod;
        const breaks = moraleBreaks(total, ml);
        say(
          `Morale vs ${ml}`,
          breaks ? `${total}: breaks, flees or surrenders` : `${total}: holds`,
          `(2d6=${r.rolls.join("+")}${signed(mod)})`,
          breaks ? "hit" : "miss",
        );
      },
      h("label", { class: "field" }, h("span", { class: "label" }, "Morale"), moraleScore),
      h("label", { class: "field" }, h("span", { class: "label" }, "Modifier"), moraleMod),
      button("Roll 2d6", null, "btn", "submit"),
    ),
  );

  // ── initiative ──
  const sides = text({ value: "Party, Enemies", "aria-label": "Sides" });
  const initiative = block(
    "Initiative",
    h(
      "div",
      { class: "stack" },
      form(
        () => {
          const names = sides.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s);
          if (names.length < 2) return fail(new Error("Name at least two sides, split by commas."));
          const [rolls, order] = initLines(names, 1);
          say("Initiative", order.trim(), rolls.replace(/^Initiative: /, ""));
        },
        sides,
        button("Roll d6s", null, "btn", "submit"),
      ),
      h("p", { class: "hint" }, "Each side rolls a d6; highest acts first. Ties roll again."),
    ),
  );

  // ── wandering check ──
  const chance = numInput("1", { min: "1", max: "6", "aria-label": "Chance in 6" });
  const wanderCheck = (): void => {
    const c = Math.min(6, Math.max(1, intOf(chance, 1)));
    const r = roll("1d6");
    const hit = r.total <= c;
    say(
      `Wandering (${c}-in-6)`,
      hit ? "Encounter!" : "No encounter",
      `(1d6=${r.total})`,
      hit ? "hit" : "",
    );
  };
  const wander = block(
    "Wandering check",
    form(
      wanderCheck,
      h("label", { class: "field" }, h("span", { class: "label" }, "Chance in 6"), chance),
      button("Roll d6", null, "btn", "submit"),
    ),
  );

  // ── the turn clock ──
  let turns = loadTurns();
  const clockLine = h("p", { class: "load-line" });
  const tracked = h("ul", { class: "plain" });
  const turnsIn = numInput("1", { min: "1", "aria-label": "Turns to advance" });
  const everyIn = numInput(String(turns.checkEvery), {
    min: "1",
    "aria-label": "Check every N turns",
  });
  const trackName = text({ placeholder: "torch, spell…", "aria-label": "Track what" });
  const trackFor = text({ placeholder: "6, 30m, 1h", "aria-label": "Duration" });
  trackFor.style.flex = "0 1 6rem";

  function drawClock(): void {
    const next = turns.turn + turns.checkEvery - (turns.turn % turns.checkEvery);
    clockLine.textContent = `Turn ${turns.turn} (${formatElapsed(turns.turn)} elapsed). Next wandering check: turn ${next}.`;
    tracked.replaceChildren(
      ...turns.tracked.map((t) =>
        h(
          "li",
          {},
          h("span", {}, t.name),
          h(
            "span",
            { class: t.remaining === 1 ? "warn" : "muted" },
            `${plural(t.remaining, "turn")} left`,
          ),
          h(
            "span",
            { class: "row-end" },
            button(
              "x",
              () => {
                turns.tracked = turns.tracked.filter((x) => x !== t);
                saveTurns(turns);
                drawClock();
              },
              "btn mini",
              "button",
              `Stop tracking ${t.name}`,
            ),
          ),
        ),
      ),
    );
  }

  function advanceBy(n: number): void {
    const result = advance(turns, n);
    saveTurns(turns);
    drawClock();
    const notes = [
      ...result.expired.map(
        (e) => `${e.name} ran out${e.turn === turns.turn ? "" : ` (turn ${e.turn})`}`,
      ),
      ...result.expiringNext.map((name) => `${name} runs out next turn`),
    ];
    say(
      `Advance ${plural(n, "turn")}`,
      `Turn ${turns.turn}`,
      notes.join("; "),
      result.expired.length ? "miss" : "",
    );
    if (result.checksDue.length > 0)
      say(
        "Wandering check due",
        result.checksDue.length === 1
          ? `turn ${result.checksDue[0]}`
          : `turns ${result.checksDue.join(", ")}`,
        "Roll it under Wandering check.",
      );
  }

  const clock = block(
    "Turns",
    h(
      "div",
      { class: "stack" },
      clockLine,
      form(
        () => advanceBy(Math.max(1, intOf(turnsIn, 1))),
        button("Advance 1", () => advanceBy(1), "btn"),
        turnsIn,
        button("Advance", null, "btn ghost", "submit"),
      ),
      form(
        () => {
          const n = intOf(everyIn, 0);
          if (n < 1) return fail(new Error("The check cadence is a whole number of turns."));
          turns.checkEvery = n;
          saveTurns(turns);
          drawClock();
          say("Wandering checks", `every ${plural(n, "turn")}`);
        },
        h("label", { class: "field" }, h("span", { class: "label" }, "Check every"), everyIn),
        button("Set", null, "btn ghost", "submit"),
      ),
      tracked,
      form(
        () => {
          const name = trackName.value.trim();
          if (!name) return fail(new Error("Name what to track."));
          try {
            const n = parseTurns(trackFor.value || "6");
            turns.tracked = turns.tracked.filter((t) => t.name !== name);
            turns.tracked.push({ name, remaining: n });
            saveTurns(turns);
            drawClock();
            say(`Tracking ${name}`, plural(n, "turn"), `runs out on turn ${turns.turn + n}`);
            trackName.value = "";
            trackFor.value = "";
          } catch (err) {
            fail(err);
          }
        },
        trackName,
        trackFor,
        button("Track", null, "btn ghost", "submit"),
      ),
      h(
        "div",
        { class: "row" },
        button("End session", () => {
          if (turns.turn === 0 && turns.tracked.length === 0) return;
          say("Session ended", `${plural(turns.turn, "turn")} (${formatElapsed(turns.turn)})`);
          turns = { ...freshState(), checkEvery: turns.checkEvery };
          saveTurns(turns);
          drawClock();
        }),
      ),
    ),
  );
  drawClock();

  // ── lookup in the saved book ──
  const query = text({
    type: "search",
    placeholder: "spell, glamour, knack or rune",
    "aria-label": "Look up",
  });
  const results = h("div", { class: "trait-list lookup-results" });
  const lookupHint = h("p", { class: "hint" });

  function drawLookup(): void {
    const q = query.value.trim().toLowerCase();
    if (!book) {
      lookupHint.textContent =
        "Load your Player's Book to look up its spells, glamours, knacks and runes.";
      results.replaceChildren();
      return;
    }
    if (q.length < 2) {
      lookupHint.textContent = "Type two letters or more of a name.";
      results.replaceChildren();
      return;
    }
    // Exact names first, then names that start with the query, then the rest.
    const rank = (name: string): number => {
      const n = name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (n.split(/[\s-]+/).some((w) => w.startsWith(q))) return 2;
      return n.includes(q) ? 3 : -1;
    };
    const runes = bookRules(book).runes;
    const glamours = new Map(book.glamourDetails);
    const entries: { name: string; draw: () => HTMLElement }[] = [
      ...book.spells.map((s) => ({
        name: s.name,
        draw: () =>
          castingEntry(
            s.name,
            [s.tradition, s.rank ? `rank ${s.rank}` : ""].filter((x) => x).join(" ") || "spell",
            s.duration,
            s.range,
            s.body,
          ),
      })),
      ...book.glamoursTable.map((name) => ({
        name,
        draw: () => {
          const g = glamours.get(name.toLowerCase());
          return castingEntry(
            name,
            "glamour",
            g?.duration ?? null,
            g?.range ?? null,
            g?.body ?? null,
          );
        },
      })),
      ...book.knacks.map((k) => ({
        name: k.name,
        draw: () => traitParagraph({ name: `${k.name} (knack)`, text: k.text }),
      })),
      ...runes.runes.map((r) => ({
        name: r.name,
        draw: () => {
          const bands = (runes.usage[r.magnitude] ?? [])
            .map((u) => {
              const levels =
                u.maxLevel === null
                  ? `${u.minLevel}+`
                  : u.maxLevel === u.minLevel
                    ? `${u.minLevel}`
                    : `${u.minLevel}–${u.maxLevel}`;
              return `Level ${levels}: ${u.text}`;
            })
            .join("; ");
          return castingEntry(r.name, `${r.magnitude} rune`, null, null, bands || null);
        },
      })),
    ];
    const found = entries
      .map((e) => ({ e, r: rank(e.name) }))
      .filter((x) => x.r >= 0)
      .toSorted((x, y) => x.r - y.r)
      .map((x) => x.e);
    const shown = found.slice(0, 25).map((e) => e.draw());
    lookupHint.textContent =
      found.length === 0
        ? `Nothing in ${book.fileName} matches “${query.value.trim()}”.`
        : found.length > shown.length
          ? `${found.length} matches; the first ${shown.length} are shown.`
          : plural(found.length, "match", "matches");
    results.replaceChildren(...shown);
  }
  query.addEventListener("input", drawLookup);

  const lookup = block("Look up", h("div", { class: "stack" }, query, lookupHint, results), "wide");

  root.replaceChildren(
    h(
      "div",
      { class: "party table-tools" },
      h(
        "div",
        { class: "member__grid" },
        logBlock,
        dice,
        react,
        morale,
        initiative,
        wander,
        clock,
        lookup,
      ),
    ),
  );
  drawLookup();

  return {
    setBook(b) {
      book = b;
      drawLookup();
    },
  };
}
