import { useCallback, useMemo } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { useCatalogueRead } from "../discover/CatalogueReadContext";
import { TmdbAttribution } from "../discover/TmdbAttribution";
import { MadeShelf } from "../made/MadeShelf";
import { useMadeInReverie, type MadeFilm } from "../made/madeInReverie";
import { TopBar } from "../shell/TopBar";
import { shelfSourceFor } from "./catalogueShelves";
import { HomeHero, heroOf } from "./HomeHero";
import { JamSpotlight, stillFor } from "./JamSpotlight";
import type { HomeRow } from "./rowMove";
import { Shelf, shelfItems } from "./Shelf";
import type { ShelfState } from "./shelfLoader";
import { SHELVES, SPOTLIGHT_AFTER } from "./shelves";
import { useHomeNavigation } from "./useHomeNavigation";
import { useHomeShelves, type ShelfSourceLike } from "./useHomeShelves";

type HomeScreenProps = {
  onOpenFilm: (title: CatalogueTitle) => void;
  onStartJam: () => void;
  onJoin: () => void;
  /** Opens a room made here. Its own screen is the room's, not a film page. */
  onOpenMade: (film: MadeFilm) => void;
  /** A film page opened from here covers the home, which keeps its place underneath. */
  inert?: boolean;
  /** Where shelves come from. By default, the catalogue read the app provides. */
  shelves?: ShelfSourceLike;
};

const HERO_ROW = "hero";
const JAM_ROW = "jam";
const MADE_ROW = "made";
const shelfRow = (index: number) => `shelf:${SHELVES[index].id}`;
const shelfOfRow = (row: string) => SHELVES.findIndex((_, index) => shelfRow(index) === row);

/** The shelf read next after focus enters `row`: the one below it. */
function shelfAfter(row: string) {
  if (row === HERO_ROW) return 0;
  if (row === JAM_ROW) return SPOTLIGHT_AFTER;
  const index = shelfOfRow(row);
  return index >= 0 ? index + 1 : -1;
}

/**
 * The home a viewer lands in: one film large at the top, then shelves of films by genre and by
 * era, with the Movie Jam spotlight and the Made in Reverie shelf among them — what the
 * catalogue holds and what has been made here, on the same page, which is the claim. A remote moves along a shelf with Left and Right
 * and between shelves with Up and Down; Up from the first row reaches the top bar.
 *
 * Only the first two shelves are read when the home opens. The rest are read as they approach
 * the viewport, or as focus reaches the shelf above them, so a viewer who never scrolls costs two
 * catalogue reads.
 */
export function HomeScreen({ onOpenFilm, onStartJam, onJoin, onOpenMade, inert = false, shelves }: HomeScreenProps) {
  const read = useCatalogueRead();
  const source = shelves ?? shelfSourceFor(read);
  // Under a film page, the home reads nothing new; one reached by URL reads nothing until it closes.
  const { states, approach, retry, observe } = useHomeShelves(source, !inert);
  const hero = heroOf(states[0]);
  const still = stillFor(states[SPOTLIGHT_AFTER - 1], hero);
  const unavailable = states.some(({ phase }) => phase === "not_configured");
  // Under a film page the home reads nothing new, the made shelf included.
  const made = useMadeInReverie(!inert);
  const madeCount = made.phase === "ready" ? made.films.length : 0;

  const rows = useMemo(() => homeRows(states, hero, unavailable, madeCount), [states, hero, unavailable, madeCount]);

  // With no catalogue there are no shelves to read, whatever row focus reaches.
  const onWait = useCallback((row: string) => (unavailable ? undefined : approach(shelfOfRow(row))), [approach, unavailable]);
  const onRow = useCallback((row: string) => (unavailable ? undefined : approach(shelfAfter(row))), [approach, unavailable]);
  const { containerRef, memory, onFocus, onKeyDown, awaitRow, enterFirstRow } = useHomeNavigation(rows, { inert, onWait, onRow });

  const attribution = states.find((state): state is Extract<ShelfState, { phase: "ready" }> => state.phase === "ready");

  const shelf = (index: number) => (
    <Shelf
      key={SHELVES[index].id}
      spec={SHELVES[index]}
      state={states[index]}
      items={shelfItems(states[index], index === 0 ? hero : null)}
      rowKey={shelfRow(index)}
      memory={memory}
      sectionRef={observe[index]}
      onOpen={onOpenFilm}
      onRetry={() => {
        awaitRow(shelfRow(index));
        retry(index);
      }}
    />
  );

  return (
    <main className="home-shell" inert={inert}>
      <TopBar current="home" onEnterPage={enterFirstRow} />
      <h1 className="sr-only">Reverie</h1>
      <div className="home-rows" ref={containerRef} onKeyDown={onKeyDown} onFocus={onFocus}>
        <HomeHero state={states[0]} film={hero} shelfTitle={SHELVES[0].title} rowKey={HERO_ROW} memory={memory} onOpen={onOpenFilm} />
        {!unavailable && SHELVES.slice(0, SPOTLIGHT_AFTER).map((_, index) => shelf(index))}
        <JamSpotlight still={still} rowKey={JAM_ROW} memory={memory} onStart={onStartJam} onJoin={onJoin} />
        <MadeShelf state={made} rowKey={MADE_ROW} memory={memory} onOpen={onOpenMade} />
        {!unavailable && SHELVES.slice(SPOTLIGHT_AFTER).map((_, offset) => shelf(SPOTLIGHT_AFTER + offset))}
      </div>
      {attribution && <TmdbAttribution text={attribution.attribution} />}
    </main>
  );
}

/**
 * The rows a remote moves through, top to bottom, as `rowMove` sees them. A shelf that loaded
 * empty is not on screen, so it is not a row; one still loading is a row that vertical moves wait
 * for; a failed one is a row holding its retry button.
 */
function homeRows(states: readonly ShelfState[], hero: CatalogueTitle | null, unavailable: boolean, madeCount: number): HomeRow[] {
  const shelfRows = (from: number, to: number) =>
    unavailable
      ? []
      : SHELVES.slice(from, to).flatMap((_, offset): HomeRow[] => {
          const index = from + offset;
          const state = states[index];
          if (state.phase === "idle" || state.phase === "loading") return [{ key: shelfRow(index), count: 0, pending: true }];
          if (state.phase === "error") return [{ key: shelfRow(index), count: state.retryable ? 1 : 0 }];
          const count = shelfItems(state, index === 0 ? hero : null).length;
          return count > 0 ? [{ key: shelfRow(index), count }] : [];
        });
  const first = states[0];
  return [
    { key: HERO_ROW, count: hero ? 1 : 0, pending: first.phase === "idle" || first.phase === "loading" },
    ...shelfRows(0, SPOTLIGHT_AFTER),
    { key: JAM_ROW, count: 2 },
    // A shelf saying there is nothing yet holds nothing to focus; it is not a row.
    ...(madeCount > 0 ? [{ key: MADE_ROW, count: madeCount }] : []),
    ...shelfRows(SPOTLIGHT_AFTER, SHELVES.length),
  ];
}
