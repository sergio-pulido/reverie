import type { CatalogueTitle } from "../catalogue/contract";
import type { ShelfState } from "./shelfLoader";
import { cellProps } from "./useHomeNavigation";

/**
 * The still behind the spotlight: a real film's backdrop from the shelf just above it, never the
 * hero's. It is taken from the far end of that shelf, so the same film is not on screen twice,
 * poster above still. It comes from a read the home has already made, so it costs nothing.
 */
export function stillFor(state: ShelfState | undefined, hero: CatalogueTitle | null): CatalogueTitle | null {
  if (state?.phase !== "ready") return null;
  return [...state.items].reverse().find((title) => title.backdropUrl && title.id !== hero?.id) ?? null;
}

type JamSpotlightProps = {
  still: CatalogueTitle | null;
  rowKey: string;
  memory: ReadonlyMap<string, number>;
  onStart: () => void;
  onJoin: () => void;
};

/**
 * Movie Jam, promoted among the shelves: a full-width banner over a real film still, with the
 * two things a viewer can do about it. Both are real, focusable actions.
 */
export function JamSpotlight({ still, rowKey, memory, onStart, onJoin }: JamSpotlightProps) {
  return (
    <section className="home-jam" aria-labelledby="home-jam-title">
      {still?.backdropUrl && <img key={still.id} className="home-jam-still" src={still.backdropUrl} alt="" aria-hidden="true" loading="lazy" decoding="async" />}
      <div className="home-jam-copy">
        <p className="home-jam-eyebrow">MOVIE JAM</p>
        <h2 className="home-jam-title" id="home-jam-title">
          Make the next scene <em>together.</em>
        </h2>
        <p className="home-jam-intro">Start a room, invite the people around you, and direct a new story one clear turn at a time.</p>
        <div className="home-actions">
          <button type="button" className="tv-action tv-action-primary" {...cellProps(rowKey, 0, memory)} onClick={onStart}>
            Start a Movie Jam
          </button>
          <button type="button" className="tv-action" {...cellProps(rowKey, 1, memory)} onClick={onJoin}>
            Join with an invite
          </button>
        </div>
      </div>
      {still && (
        <p className="home-jam-credit">
          Still from {still.title}
          {still.year ? ` (${still.year})` : ""}
        </p>
      )}
    </section>
  );
}
