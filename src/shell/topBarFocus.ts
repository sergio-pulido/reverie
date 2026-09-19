/**
 * Focus hand-offs to and from the top bar, shared by every screen.
 *
 * More than one bar can be in the document at once: a film page is a layer over the screen it
 * was opened from, and that screen (bar included) is `inert` while it is open. The live bar is
 * the one outside any inert subtree, and it is the only one these helpers ever touch.
 */

const BAR = "[data-top-bar]";
const BAR_ITEM = "[data-top-bar-item]";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

export function liveTopBar(): HTMLElement | null {
  const bars = Array.from(document.querySelectorAll<HTMLElement>(BAR)).filter((bar) => !bar.closest("[inert]"));
  return bars[bars.length - 1] ?? null;
}

export function topBarItems(bar: HTMLElement): HTMLElement[] {
  return Array.from(bar.querySelectorAll<HTMLElement>(BAR_ITEM));
}

export function isInLiveTopBar(element: Element | null): boolean {
  const bar = liveTopBar();
  return Boolean(bar && element && bar.contains(element));
}

/**
 * Scrolls the page (and any scrolling layer the bar lives in) back to the top and focuses the
 * bar's current destination. Returns false when no bar is on screen.
 */
export function focusTopBar({ scroll = true }: { scroll?: boolean } = {}): boolean {
  const bar = liveTopBar();
  if (!bar) return false;
  if (scroll) scrollToTop(bar);
  const items = topBarItems(bar);
  const target = items.find((item) => item.getAttribute("aria-current") === "page") ?? items[0];
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

/**
 * Scrolls whatever the bar scrolls with. A bar inside a layer (`data-scroll-layer`) scrolls that
 * layer only: the screen underneath keeps its place, so closing the layer finds it unmoved.
 */
function scrollToTop(bar: HTMLElement) {
  const layer = bar.closest<HTMLElement>("[data-scroll-layer]");
  if (layer) layer.scrollTop = 0;
  else window.scrollTo({ top: 0 });
}

/**
 * A page with nothing below the bar to focus (a film page that offers no action) still has to be
 * readable with a remote: Down moves it one step, most of a screen, instead of doing nothing.
 */
export function scrollPageBelow(bar: HTMLElement) {
  const layer = bar.closest<HTMLElement>("[data-scroll-layer]");
  if (layer) layer.scrollTop += Math.round(layer.clientHeight * 0.6);
  else window.scrollBy({ top: Math.round(window.innerHeight * 0.6) });
}

/** The screen a bar belongs to: the element that holds the bar and the page beneath it. */
function screenOf(bar: HTMLElement): HTMLElement {
  return bar.parentElement ?? document.body;
}

/** The first thing on the page a viewer can focus, below the bar. */
export function firstContent(bar: HTMLElement | null = liveTopBar()): HTMLElement | null {
  if (!bar) return null;
  const candidates = Array.from(screenOf(bar).querySelectorAll<HTMLElement>(FOCUSABLE));
  return candidates.find((element) => !bar.contains(element) && isReachable(element)) ?? null;
}

/** Down from the bar: into the page's first row. */
export function focusFirstContent(bar: HTMLElement | null = liveTopBar()): boolean {
  const target = firstContent(bar);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return Boolean(target);
}

/** A roving item that is not the row's current one (tabindex -1) is not a landing place. */
function isReachable(element: HTMLElement) {
  if (element.getAttribute("tabindex") === "-1") return false;
  if (element.closest("[inert], [hidden], [aria-hidden='true']")) return false;
  return !(element instanceof HTMLInputElement && element.type === "hidden");
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "number", "password", "tel", "url", ""]);

/** Whether keys typed at `element` edit text, so Backspace must stay Backspace. */
export function isEditable(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Arrow keys have their own meaning here (a caret line, a list, a stepper), so Up is never taken from it. */
export function ownsVerticalArrows(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  return element instanceof HTMLInputElement && (element.type === "number" || element.type === "range");
}

/** Nothing holds focus: a remote would be pressing keys at nothing. */
export function focusIsLost(element: Element | null = document.activeElement): boolean {
  return !element || element === document.body || element === document.documentElement || Boolean(element.closest("[inert]"));
}
