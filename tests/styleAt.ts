/**
 * What a stylesheet says about an element at a given screen width.
 *
 * The test document has no layout engine, so nothing here measures anything. It reads the real
 * stylesheet instead: it parses it, keeps the rules whose media conditions a screen of that width
 * meets, matches them against the rendered element by selector and specificity, and answers with
 * the declarations that would apply. That is enough to state what the browser will do — which
 * rows scroll, which layer fills the screen, whether anything declares itself wider than the
 * screen it is on — without claiming to have measured a page that was never laid out.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

type Rule = { selector: string; specificity: number; order: number; declarations: ReadonlyMap<string, string> };

const sheets = new Map<string, CSSStyleSheet>();

/** Parses `path` once per run, through the document's own CSS parser. */
export function stylesheet(path: string): CSSStyleSheet {
  const loaded = sheets.get(path);
  if (loaded) return loaded;
  const style = document.createElement("style");
  style.textContent = readFileSync(path, "utf8");
  document.head.append(style);
  const sheet = style.sheet;
  assert.ok(sheet, `${path} parsed`);
  sheets.set(path, sheet);
  return sheet;
}

/**
 * Whether a screen `width` pixels wide meets `condition`. Only the conditions these stylesheets
 * use are understood; anything else throws rather than quietly counting as a match, because a
 * condition read wrongly would make every assertion built on it meaningless.
 */
export function mediaMatches(condition: string, width: number): boolean {
  return condition
    .split(",")
    .some((alternative) =>
      alternative
        .split(" and ")
        .map((term) => term.trim())
        .filter(Boolean)
        .every((term) => {
          const max = /^\(max-width:\s*(\d+)px\)$/.exec(term);
          if (max) return width <= Number(max[1]);
          const min = /^\(min-width:\s*(\d+)px\)$/.exec(term);
          if (min) return width >= Number(min[1]);
          // A test document neither prefers reduced motion nor hovers.
          if (/^\(prefers-reduced-motion:\s*reduce\)$/.test(term)) return false;
          if (/^\(hover:\s*hover\)$/.test(term)) return false;
          if (term === "screen" || term === "all") return true;
          throw new Error(`unknown media condition: ${term}`);
        }),
    );
}

/** Roughly CSS's own: ids, then classes and attributes and pseudo-classes, then element names. */
function specificityOf(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!:)/g) ?? []).length;
  const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + elements;
}

/** Rules that are about drawing one element, in cascade order, for a screen `width` wide. */
function rulesAt(sheet: CSSStyleSheet, width: number): Rule[] {
  const rules: Rule[] = [];
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule.constructor.name === "CSSMediaRule") {
        const media = rule as CSSMediaRule;
        if (mediaMatches(media.conditionText ?? media.media.mediaText, width)) walk(media.cssRules);
        continue;
      }
      if (rule.constructor.name !== "CSSStyleRule") continue;
      const style = rule as CSSStyleRule;
      for (const selector of style.selectorText.split(",").map((one) => one.trim())) {
        // A state (focus, hover) or a generated box is not this element's resting layout.
        if (/::|:focus|:hover|:disabled|:not\(/.test(selector)) continue;
        const declarations = new Map<string, string>();
        for (const property of Array.from(style.style)) declarations.set(property, style.style.getPropertyValue(property).trim());
        rules.push({ selector, specificity: specificityOf(selector), order: rules.length, declarations });
      }
    }
  };
  walk(sheet.cssRules);
  return rules;
}

const cache = new Map<string, Rule[]>();
function rulesFor(paths: readonly string[], width: number): Rule[] {
  const key = `${width}:${paths.join("|")}`;
  const known = cache.get(key);
  if (known) return known;
  const rules = paths.flatMap((path) => rulesAt(stylesheet(path), width));
  rules.forEach((rule, index) => (rule.order = index));
  cache.set(key, rules);
  return rules;
}

export type Styles = (element: Element) => Map<string, string>;

/** The declarations `paths` apply to an element on a screen `width` pixels wide. */
export function stylesAt(paths: readonly string[], width: number): Styles {
  const rules = rulesFor(paths, width);
  return (element) => {
    const applied = new Map<string, string>();
    const matching = rules
      .filter((rule) => element.matches(rule.selector))
      .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    for (const rule of matching) for (const [property, value] of rule.declarations) applied.set(property, value);
    return applied;
  };
}

/** One declaration, or null where nothing sets it. */
export function declared(styles: Styles, element: Element | null, property: string): string | null {
  assert.ok(element, `there is an element to read ${property} from`);
  return styles(element).get(property) ?? null;
}

const SCROLLS_SIDEWAYS = new Set(["auto", "scroll"]);
/** A plain pixel length, or null for anything that needs a layout to know (`var`, `calc`, `%`). */
function pixels(value: string | undefined): number | null {
  const match = value && /^(-?[\d.]+)px$/.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * Everything on the page that declares itself wider than a screen `width` pixels wide, ignoring
 * what is inside a row that scrolls sideways on purpose. Lengths a stylesheet leaves to the
 * layout (`var()`, `calc()`, percentages) are not judged here; the tests state those directly.
 */
export function widerThanScreen(root: Element, styles: Styles, width: number): string[] {
  const guilty: string[] = [];
  const scrollers = new Set<Element>();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const applied = styles(element);
    if (SCROLLS_SIDEWAYS.has(applied.get("overflow-x") ?? "") || SCROLLS_SIDEWAYS.has(applied.get("overflow") ?? "")) scrollers.add(element);
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.parentElement && [...scrollers].some((scroller) => scroller !== element && scroller.contains(element))) continue;
    const applied = styles(element);
    for (const property of ["width", "min-width"]) {
      const size = pixels(applied.get(property));
      if (size !== null && size > width) guilty.push(`${name(element)} declares ${property}: ${applied.get(property)}`);
    }
    const sides = (pixels(applied.get("padding-left")) ?? 0) + (pixels(applied.get("padding-right")) ?? 0);
    if (sides >= width) guilty.push(`${name(element)} is padded ${sides}px on a ${width}px screen`);
  }
  return guilty;
}

function name(element: Element) {
  return `${element.tagName.toLowerCase()}${String(element.className || "").split(" ").filter(Boolean).map((one) => `.${one}`).join("")}`;
}
