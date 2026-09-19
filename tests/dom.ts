/**
 * A browser-like document for component tests, installed before React is imported. Import this
 * module first in any test that renders: ES modules evaluate their imports in order, so React DOM
 * sees a window when it loads.
 *
 * jsdom has no layout, so nothing here measures anything. It also lacks the few browser APIs the
 * screens call, and those are replaced by recorders a test can inspect: `scrollTo`,
 * `scrollIntoView` and `IntersectionObserver`, whose intersections a test reports by hand.
 */
import { JSDOM, VirtualConsole } from "jsdom";

/** Anything the document itself reports as broken (an unimplemented API, a script error). */
export const domErrors: string[] = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error: Error) => domErrors.push(error.message));

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

/** Node's own networking and abort primitives stay: `fetch` needs Node's AbortSignal. */
const KEEP_NODE = new Set(["fetch", "AbortController", "AbortSignal", "Request", "Response", "Headers", "crypto", "performance", "URL", "URLSearchParams"]);

for (const key of Object.getOwnPropertyNames(window)) {
  if (KEEP_NODE.has(key) || key in globalThis) continue;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (window as unknown as Record<string, unknown>)[key] });
}
for (const key of ["window", "document", "navigator", "location", "history", "Event", "EventTarget", "CustomEvent", "KeyboardEvent", "FocusEvent", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (window as unknown as Record<string, unknown>)[key] });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `window.scrollTo` call, newest last. */
export const scrollCalls: unknown[] = [];
window.scrollTo = ((...args: unknown[]) => {
  scrollCalls.push(args.length === 1 ? args[0] : { left: args[0], top: args[1] });
}) as typeof window.scrollTo;
window.scrollBy = ((...args: unknown[]) => {
  scrollCalls.push({ by: args.length === 1 ? args[0] : { left: args[0], top: args[1] } });
}) as typeof window.scrollBy;
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
window.HTMLElement.prototype.scrollTo = function scrollTo() {} as typeof window.HTMLElement.prototype.scrollTo;

type ObserverRecord = { callback: IntersectionObserverCallback; targets: Set<Element>; options?: IntersectionObserverInit };

/** Every IntersectionObserver the page has created and not disconnected. */
export const observers = new Set<ObserverRecord>();

/**
 * Behaves like the browser's: observing a target reports its current state once, soon after, and
 * everything the page has not scrolled to is reported as not intersecting.
 */
class FakeIntersectionObserver {
  private readonly record: ObserverRecord;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, targets: new Set(), options };
    observers.add(this.record);
  }
  observe(target: Element) {
    this.record.targets.add(target);
    queueMicrotask(() => {
      if (!this.record.targets.has(target)) return;
      const entry = { target, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry;
      this.record.callback([entry], this as unknown as IntersectionObserver);
    });
  }
  unobserve(target: Element) {
    this.record.targets.delete(target);
  }
  disconnect() {
    this.record.targets.clear();
    observers.delete(this.record);
  }
  takeRecords() {
    return [];
  }
}
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: FakeIntersectionObserver });
Object.defineProperty(window, "IntersectionObserver", { configurable: true, writable: true, value: FakeIntersectionObserver });

/** Reports `target` as entering (or leaving) the observed area, as a scroll would. */
export function intersect(target: Element, isIntersecting = true) {
  for (const record of [...observers]) {
    if (!record.targets.has(target)) continue;
    const entry = { target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as unknown as IntersectionObserverEntry;
    record.callback([entry], record as unknown as IntersectionObserver);
  }
}

/** Whether anything is watching `target`. */
export function isObserved(target: Element) {
  return [...observers].some((record) => record.targets.has(target));
}

export { window as domWindow };
