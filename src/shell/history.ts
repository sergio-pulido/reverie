/**
 * What the app records in each browser history entry: a key naming the entry, and for an entry it
 * pushed, the path and the key of the entry it was opened from.
 *
 * Leaving a screen uses the record to step back through real history when the entry behind is
 * where the viewer should go, and to replace the entry otherwise, so repeated Back always climbs
 * towards the home instead of replaying every screen visited. A film page also reads it to know
 * whether it was opened from the home or from the Discover grid.
 *
 * Replacing an entry changes what lies behind the entries after it (browser Forward can reach
 * them again). Their record would then be stale, so every replaced key is remembered, for the
 * whole tab session, and an entry whose opener was replaced is never stepped back to.
 */
export type HistoryEntryState = { "reverie:from"?: string; "reverie:key"?: string; "reverie:behind"?: string };

const FROM = "reverie:from";
const KEY = "reverie:key";
const BEHIND = "reverie:behind";
const REPLACED_STORE = "reverie:replaced";
const REPLACED_KEEP = 200;

let keys = 0;
const replaced = new Set<string>(readReplaced());

function readReplaced(): string[] {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(REPLACED_STORE) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberReplaced(key: string) {
  replaced.add(key);
  try {
    window.sessionStorage.setItem(REPLACED_STORE, JSON.stringify([...replaced].slice(-REPLACED_KEEP)));
  } catch {
    // Without session storage the record lasts as long as the page.
  }
}

function field(state: unknown, name: string): string | null {
  const value = (state as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : null;
}

function newKey() {
  keys += 1;
  return `${Date.now().toString(36)}-${keys}`;
}

/** The in-app path the current entry was opened from, or null when it was reached by URL. */
export function entryFrom(state: unknown = window.history.state): string | null {
  const from = field(state, FROM);
  return from?.startsWith("/") ? from : null;
}

/**
 * Whether stepping back from the current entry still reaches the entry it was opened from. False
 * only when that entry has since been replaced; an entry with no record is trusted.
 */
export function behindIntact(state: unknown = window.history.state): boolean {
  const behind = field(state, BEHIND);
  return behind === null || !replaced.has(behind);
}

/** Names the entry the app was opened on, keeping whatever it already records. */
export function keyCurrentEntry(): void {
  if (field(window.history.state, KEY)) return;
  window.history.replaceState({ ...(window.history.state ?? {}), [KEY]: newKey() }, "");
}

/** The state for an entry pushed from the current one. */
export function pushedEntry(): HistoryEntryState {
  const behind = field(window.history.state, KEY);
  return { [FROM]: window.location.pathname, [KEY]: newKey(), ...(behind ? { [BEHIND]: behind } : {}) };
}

/**
 * The state for an entry that replaces the current one. What lies behind it is unchanged, so it
 * keeps the current record; it is a different screen, so it gets a new key, and the old one is
 * remembered as replaced.
 */
export function replacingEntry(): HistoryEntryState {
  const state = window.history.state;
  const old = field(state, KEY);
  if (old) rememberReplaced(old);
  const from = entryFrom(state);
  const behind = field(state, BEHIND);
  return { ...(from ? { [FROM]: from } : {}), [KEY]: newKey(), ...(behind ? { [BEHIND]: behind } : {}) };
}
