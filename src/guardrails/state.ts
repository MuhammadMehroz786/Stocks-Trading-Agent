import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export type DayState = {
  date: string;
  startOfDayValue: number;
  currentValue: number;
  tradesToday: number;
  circuitBreakerTripped: boolean;
};

const STATE_PATH = "data/state.json";

function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function ensureDir(p: string) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function readState(): DayState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as DayState;
  } catch {
    return null;
  }
}

function writeState(state: DayState): void {
  ensureDir(STATE_PATH);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recomputeIfNewDay(currentValue: number): DayState {
  const today = todayET();
  const existing = readState();
  if (!existing || existing.date !== today) {
    const fresh: DayState = {
      date: today,
      startOfDayValue: currentValue,
      currentValue,
      tradesToday: 0,
      circuitBreakerTripped: false,
    };
    writeState(fresh);
    return fresh;
  }
  existing.currentValue = currentValue;
  writeState(existing);
  return existing;
}

export function incrementTradeCount(): DayState {
  const state = readState();
  if (!state) throw new Error("state not initialized — call recomputeIfNewDay first");
  state.tradesToday += 1;
  writeState(state);
  return state;
}

export function markCircuitBreakerTripped(): DayState {
  const state = readState();
  if (!state) throw new Error("state not initialized — call recomputeIfNewDay first");
  state.circuitBreakerTripped = true;
  writeState(state);
  return state;
}

export function getCurrentState(): DayState | null {
  return readState();
}
