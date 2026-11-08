import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { freshState, readTurnState, type TurnState } from "./turn-clock.ts";

// Same machine-local home as dw.db and the extraction cache (db.ts), so the
// session survives switching or re-cloning checkouts.
const CACHE_DIR = join(homedir(), ".cache", "dw");

export * from "./turn-clock.ts";

export function statePath(): string {
  const env = process.env.DW_SESSION?.trim();
  return env || join(CACHE_DIR, "dw-session.json");
}

export function loadState(): { state: TurnState; note?: string } {
  const path = statePath();
  if (!existsSync(path)) return { state: freshState() };
  try {
    const state = readTurnState(JSON.parse(readFileSync(path, "utf8")));
    if (!state) throw new Error("bad shape");
    return { state };
  } catch {
    return { state: freshState(), note: `Turn state at ${path} was unreadable; starting fresh.` };
  }
}

export function saveState(state: TurnState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function clearState(): void {
  rmSync(statePath(), { force: true });
}
