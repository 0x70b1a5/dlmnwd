import { initLines } from "../initiative.ts";

export function cmdInit(args: string[]): void {
  const names: string[] = [];
  let rounds = 1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-r" || a === "--rounds") rounds = parseInt(args[++i] ?? "", 10);
    else if (a.startsWith("--rounds=")) rounds = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("-")) rounds = NaN;
    else names.push(a);
  }
  const sides = names.length ? names : ["Party", "Enemies"];
  if (sides.length < 2 || !Number.isInteger(rounds) || rounds < 1) {
    console.error("usage: dw init [side side ...] [-r/--rounds <n>]");
    process.exit(1);
  }
  for (const line of initLines(sides, rounds)) console.log(line);
}
