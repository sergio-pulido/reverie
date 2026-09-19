/**
 * Rendering for component tests. It imports the document first, so React DOM finds a window when
 * it loads; tests import this module and never React DOM directly.
 */
import { domErrors, scrollCalls } from "./dom";
import assert from "node:assert/strict";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mounted: { root: Root; container: HTMLElement } | null = null;
const consoleErrors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(" "));
};

/** A history entry: where the viewer is, and what the app recorded there. */
export type Entry = { path: string; state?: unknown };

/**
 * Renders `ui` into a fresh container, replacing whatever the last test rendered. `at` is where
 * the viewer is: a path, or the entries they went through, the current one last.
 */
export async function render(ui: ReactElement, at: string | Entry[] = "/home") {
  await cleanup();
  const entries = typeof at === "string" ? [{ path: at }] : at;
  window.history.replaceState(entries[0].state ?? null, "", entries[0].path);
  for (const entry of entries.slice(1)) window.history.pushState(entry.state ?? null, "", entry.path);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(ui);
  });
  await settle();
  return container;
}

/** Renders `ui` into the root the last `render` created, as a parent re-rendering with new props would. */
export async function rerender(ui: ReactElement) {
  assert.ok(mounted, "something was rendered");
  const { root } = mounted;
  await act(async () => {
    root.render(ui);
  });
  await settle();
}

/**
 * Unmounts, resets the location and the recorders, and fails the test if React or the document
 * reported an error while it ran.
 */
export async function cleanup() {
  if (mounted) {
    const { root, container } = mounted;
    mounted = null;
    await act(async () => root.unmount());
    container.remove();
  }
  window.history.replaceState(null, "", "/");
  document.documentElement.className = "";
  scrollCalls.length = 0;
  const errors = [...consoleErrors, ...domErrors];
  consoleErrors.length = 0;
  domErrors.length = 0;
  assert.deepEqual(errors, [], "no errors were reported while the test ran");
}

/** Lets pending promises, timers at 0 ms and the effects they cause run. */
export async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Presses `key` on whatever holds focus, as a remote would, and answers whether something took
 * it (called preventDefault). Pressing with nothing focused is refused unless `allowLost` says
 * the test means it.
 */
export async function press(key: string, init: KeyboardEventInit & { allowLost?: boolean } = {}) {
  const { allowLost = false, ...eventInit } = init;
  const target = document.activeElement ?? document.body;
  if (!allowLost) assert.notEqual(target, document.body, `nothing is focused when ${key} is pressed`);
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...eventInit });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle(1);
  return event.defaultPrevented;
}

export async function click(element: Element | null) {
  assert.ok(element instanceof window.HTMLElement, "there is something to click");
  await act(async () => {
    element.click();
  });
  await settle();
}

/** Moves focus as a pointer or a screen reader might, outside any key press. */
export async function focusOn(element: Element | null) {
  assert.ok(element instanceof window.HTMLElement, "there is something to focus");
  await act(async () => {
    element.focus();
  });
  await settle(1);
}

/** Takes focus away from everything, as a closing layer does. */
export async function loseFocus() {
  await act(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

export function focused(): HTMLElement {
  return document.activeElement as HTMLElement;
}

export { originalError };
