// Client-side Dolmenwood character generator. The whole pipeline (parse the
// user's PDF, build the kindred/class data, roll a character) runs in the
// browser, so the book content never leaves the machine. Same parsers as the
// CLI, fed by the pdf.js layout emulator instead of pdftotext. The sheet
// rendering lives in sheet.ts (shared with the mock page).

// Importing the worker module runs pdf.js on the main thread (it sets
// globalThis.pdfjsWorker on import), so there is no separate worker file to
// fetch. That keeps the app bundleable into a single self-contained HTML that
// still parses PDFs, at the cost of a brief pause while a book is read. It is
// the unminified build because patches/pdfjs-dist@*.patch only patches that one.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

import { type Character, generate, toMarkdown } from "../src/gen/character.ts";
import { extractPagesEmulated } from "../src/pdf/emulate.ts";
import { canBeAlignment, canBeClass, rollAlignment, rollKindredClass } from "../src/rules.ts";
import {
  type Book,
  bookRules,
  forgetBook,
  loadSavedBook,
  parseBook,
  saveBook,
  spellMap,
} from "./book.ts";
import { pcMarkdown } from "../src/party/render.ts";
import { emptyRules } from "../src/party/rules.ts";
import { memberSheet } from "./member-sheet.ts";
import { mountParty } from "./party.ts";
import { mountTable } from "./table.ts";
import { download, safeName } from "./party-store.ts";
import { renderEmpty, renderSheet, renderSheetData } from "./sheet.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const pick = $<HTMLButtonElement>("pick");
const status = $<HTMLParagraphElement>("status");
const kindredSel = $<HTMLSelectElement>("kindred");
const classSel = $<HTMLSelectElement>("class");
const alignmentSel = $<HTMLSelectElement>("alignment");
const nameInput = $<HTMLInputElement>("name");
const playerInput = $<HTMLInputElement>("player");
const generateBtn = $<HTMLButtonElement>("generate");
const printBtn = $<HTMLButtonElement>("print");
const downloadBtn = $<HTMLButtonElement>("download");
const addPartyBtn = $<HTMLButtonElement>("add-party");
const forgetBtn = $<HTMLButtonElement>("forget");
const sheet = $<HTMLElement>("sheet");

// The rite's fields stay visible but inert until a book is offered.
const riteFields = [kindredSel, classSel, alignmentSel, nameInput, playerInput, generateBtn];
function setRiteEnabled(on: boolean): void {
  for (const el of riteFields) el.disabled = !on;
}

// The parsed Player's Book (book.ts): from the PDF, or saved in this browser.
let book: Book | null = null;
let lastMarkdown = "";
let lastName = "character";
let lastCharacter: Character | null = null;

// ── load & parse ──────────────────────────────────────────────────────────
pick.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  // Clear the value so picking the same file again still fires `change`.
  fileInput.value = "";
  if (file) void load(file);
});

function setStatus(msg: string, kind: "info" | "error" = "info"): void {
  status.textContent = msg;
  status.dataset.kind = kind;
}

const opt = (value: string, label: string): HTMLOptionElement => {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
};

// The empty value in either dropdown means "roll it for me".
const RANDOM = "";
const randomOpt = (): HTMLOptionElement => opt(RANDOM, "Random");

/** Rebuild the class dropdown, graying out classes the selected kindred can't take. */
function updateClassOptions(): void {
  const kindreds = book?.kindreds ?? [];
  const classes = book?.classes ?? [];
  const kindred = kindreds.find((k) => k.id === kindredSel.value);
  const prev = classSel.value;
  classSel.replaceChildren(randomOpt());
  for (const c of classes) {
    const allowed = kindred ? canBeClass(kindred.kindredType, c.id) : true;
    const o = opt(c.id, c.name);
    if (!allowed) o.disabled = true;
    classSel.append(o);
  }
  // Preserve the selection if still valid, else fall back to a random class.
  classSel.value = [...classSel.options].some((o) => o.value === prev && !o.disabled)
    ? prev
    : RANDOM;
  updateAlignmentOptions();
}

/** Toggle the Chaotic alignment option's disabled state based on the class. A
 *  random class stays compatible with Chaotic: the roll skips the classes that
 *  forbid it. */
function updateAlignmentOptions(): void {
  const klass = book?.classes.find((c) => c.id === classSel.value);
  const chaoticOpt = [...alignmentSel.options].find((o) => o.value === "Chaotic");
  if (!chaoticOpt) return;
  const allowed = klass ? canBeAlignment(klass.id, "Chaotic") : true;
  chaoticOpt.disabled = !allowed;
  if (!allowed && alignmentSel.value === "Chaotic") {
    alignmentSel.value = RANDOM;
  }
}

kindredSel.addEventListener("change", updateClassOptions);
classSel.addEventListener("change", updateAlignmentOptions);

async function load(file: File): Promise<void> {
  setStatus(`Reading ${file.name}…`);
  // Reset any prior rite so a failed/partial load can't leave a stale sheet,
  // download button, or markdown around.
  setRiteEnabled(false);
  downloadBtn.hidden = true;
  printBtn.hidden = true;
  addPartyBtn.hidden = true;
  renderEmpty(sheet);
  lastMarkdown = "";
  lastCharacter = null;
  pick.disabled = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseBook(await extractPagesEmulated(bytes), file.name);
    if (parsed.kindreds.length === 0 || parsed.classes.length === 0) {
      setStatus("No kindreds or classes found. Is this the Dolmenwood Player's Book?", "error");
      return;
    }
    const kept = saveBook(parsed);
    useBook(parsed);
    setStatus(
      `Loaded ${parsed.kindreds.length} kindreds, ${parsed.classes.length} classes.` +
        (kept ? " Kept in this browser for next time." : ""),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    setStatus(`Couldn't read that PDF: ${detail}`, "error");
  } finally {
    pick.disabled = false;
  }
}

/** Make a parsed book the one the generator and the party use. */
function useBook(b: Book): void {
  book = b;
  party.setRules(bookRules(b));
  table.setBook(b);
  kindredSel.replaceChildren(randomOpt(), ...b.kindreds.map((k) => opt(k.id, k.name)));
  updateClassOptions();
  setRiteEnabled(true);
  forgetBtn.hidden = false;
}

forgetBtn.addEventListener("click", () => {
  forgetBook();
  forgetBtn.hidden = true;
  setStatus("The book is forgotten. This page holds no book data until you load the PDF again.");
  book = null;
  setRiteEnabled(false);
  kindredSel.replaceChildren();
  classSel.replaceChildren();
  party.setRules(emptyRules());
  table.setBook(null);
});

// ── sheet and party tabs ───────────────────────────────────────────────────
type Tab = "sheet" | "party" | "table";
const tabs: Record<Tab, [HTMLButtonElement, HTMLElement]> = {
  sheet: [$<HTMLButtonElement>("tab-sheet"), $<HTMLElement>("sheet-frame")],
  party: [$<HTMLButtonElement>("tab-party"), $<HTMLElement>("party-frame")],
  table: [$<HTMLButtonElement>("tab-table"), $<HTMLElement>("table-frame")],
};
function showTab(tab: Tab): void {
  for (const [name, [btn, panel]] of Object.entries(tabs) as [
    Tab,
    [HTMLButtonElement, HTMLElement],
  ][]) {
    btn.setAttribute("aria-selected", String(name === tab));
    panel.hidden = name !== tab;
  }
}
for (const [name, [btn]] of Object.entries(tabs) as [Tab, [HTMLButtonElement, HTMLElement]][])
  btn.addEventListener("click", () => showTab(name));

const table = mountTable($<HTMLElement>("table"));

const partyCount = $<HTMLSpanElement>("party-count");
const party = mountParty($<HTMLElement>("party"), {
  onCount(n) {
    partyCount.textContent = n > 0 ? `(${n})` : "";
  },
  // A member's full sheet, as they are now, ready to print or download.
  onSheet(pc, members, rules) {
    renderSheetData(sheet, memberSheet(pc, members, rules, book));
    lastMarkdown = pcMarkdown(pc, members, rules);
    lastName = pc.name;
    lastCharacter = null;
    addPartyBtn.hidden = true;
    printBtn.hidden = false;
    downloadBtn.hidden = false;
    showTab("sheet");
    window.scrollTo(0, 0);
  },
});

// ── generate & download ────────────────────────────────────────────────────
generateBtn.addEventListener("click", () => {
  if (!book) return;
  const { kindreds, classes } = book;
  const rolled = rollKindredClass(kindreds, classes, {
    kindred: kindreds.find((k) => k.id === kindredSel.value),
    klass: classes.find((c) => c.id === classSel.value),
    alignment: alignmentSel.value,
  });
  if (!rolled) {
    setStatus("No kindred and class satisfy those constraints.", "error");
    return;
  }
  const { kindred, klass } = rolled;

  const character = generate(kindred, klass, {
    name: nameInput.value.trim() || undefined,
    player: playerInput.value.trim() || undefined,
    // Random rolls among the alignments the class allows.
    alignment: alignmentSel.value || rollAlignment(klass.id),
    adventuringItems: book.adventuringItems,
    spellRows: spellMap(book),
    glamoursTable: book.glamoursTable,
    glamourDetails: new Map(book.glamourDetails),
    knacks: book.knacks,
    symbioticFlesh: book.symbioticFlesh,
  });
  lastMarkdown = toMarkdown(character);
  lastName = character.name;
  lastCharacter = character;
  renderSheet(sheet, character);
  showTab("sheet");
  printBtn.hidden = false;
  downloadBtn.hidden = false;
  addPartyBtn.hidden = false;
  addPartyBtn.disabled = false;
});

addPartyBtn.addEventListener("click", () => {
  if (!lastCharacter) return;
  party.add(lastCharacter);
  // One character joins once; generate again for another.
  addPartyBtn.disabled = true;
  showTab("party");
});

printBtn.addEventListener("click", () => window.print());

// ── theme ──────────────────────────────────────────────────────────────────
// The head script in index.html applies the stored choice before first paint;
// this only cycles auto → dark → light and keeps the control's label in sync.
const themeBtn = $<HTMLButtonElement>("theme");
type Theme = "auto" | "dark" | "light";
const nextTheme: Record<Theme, Theme> = { auto: "dark", dark: "light", light: "auto" };

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || t === "light" ? t : "auto";
}

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  themeBtn.textContent = `theme:${theme}`;
  themeBtn.setAttribute("aria-label", `Color theme: ${theme}`);
  try {
    if (theme === "auto") localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch {}
}

applyTheme(currentTheme());
themeBtn.addEventListener("click", () => applyTheme(nextTheme[currentTheme()]));

downloadBtn.addEventListener("click", () => {
  if (!lastMarkdown) return;
  download(`${safeName(lastName, "character")}.md`, lastMarkdown, "text/markdown");
});

// Paint the demo character on first load — shows what the tool produces,
// inviting the user to load their own PDF.
import { demoCharacter } from "./demo.ts";
renderSheet(sheet, demoCharacter);

// A book read on an earlier visit: ready without the PDF.
const saved = loadSavedBook();
if (saved) {
  useBook(saved);
  const when = new Date(saved.readAt).toLocaleDateString();
  setStatus(`Using ${saved.fileName}, read on ${when} and kept in this browser.`);
}
