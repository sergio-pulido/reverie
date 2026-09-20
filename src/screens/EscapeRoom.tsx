import { useEffect, useRef, useState } from "react";
import { Notice } from "../chrome";
import type { BeatView, EscapeSnapshot, SegmentView } from "../core/escape/session";
import type { EscapeRoomActions } from "./useEscapeRoom";
import { useSegmentSource, type FetchClip } from "./useSegmentSource";

/**
 * The escape room, drawn inside the jam screen.
 *
 * Everything on it comes from the server's snapshot: the location, what has
 * been found, what is still shut, the proposals on the table, the votes cast
 * and the money committed. Nothing here counts anything of its own, and a
 * room with no generated video says so rather than showing a frame that does
 * not exist.
 *
 * The screen is never dead. The location's looping shot plays while the room
 * argues and while the next beat renders; a finished beat cuts in over it and
 * hands the screen back when it ends. A beat that never arrives is simply a
 * longer loop, which is what a measured twenty-five-second generation
 * (docs/DECISIONS.md) asks the design to survive.
 *
 * This component holds no state but which clip is on screen. Reading the room
 * and changing it belong to ./useEscapeRoom.
 */

type Showing = { kind: "loop" } | { kind: "beat"; beatId: string; loopSrc: string | null };

export function EscapeRoom({
  snapshot,
  isHost,
  displayName,
  canContribute,
  busy,
  failure,
  actions,
  fetchClip,
}: {
  snapshot: EscapeSnapshot;
  isHost: boolean;
  displayName: string;
  canContribute: boolean;
  busy: boolean;
  failure: string | null;
  actions: EscapeRoomActions;
  /** Injected in tests; production reads the clip with the viewer's token. */
  fetchClip?: FetchClip;
}) {
  const [draft, setDraft] = useState("");
  const [showing, setShowing] = useState<Showing>({ kind: "loop" });
  /** Beats whose clip this viewer has already been shown, so none repeats. */
  const played = useRef(new Set<string>());
  /** Whichever clip is on screen, so it can be restarted when the tab returns. */
  const screen = useRef<HTMLVideoElement | null>(null);

  /**
   * A hidden tab pauses its video and nothing resumes it, so a viewer who
   * looks away and comes back would find the room frozen on one frame. Asking
   * again when the tab is visible is the whole fix; it was found by watching
   * the real thing stop at 3.7 seconds of a 5.2-second loop.
   */
  useEffect(() => {
    const resume = () => {
      if (!document.hidden) startPlaying(screen.current);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);

  // A finished beat cuts in the moment its clip exists, and then stays: the
  // last thing that happened keeps looping until the next thing happens. The
  // location's own loop is only for a room where nothing has happened yet, or
  // whose last clip this server no longer holds. Going back to the untouched
  // room after every move showed the hatch shut again seconds after it was
  // opened, which read as the move being undone.
  useEffect(() => {
    const fresh = snapshot.beats.find(
      (beat) => beat.media.status === "ready" && beat.media.src && !played.current.has(beat.id),
    );
    if (!fresh) return;
    played.current.add(fresh.id);
    setShowing({ kind: "beat", beatId: fresh.id, loopSrc: snapshot.loop.src });
  }, [snapshot, showing]);

  // Once the server holds a loop of the room as it is after this beat, that
  // hold has the screen; until then the beat itself loops rather than the
  // untouched room coming back.
  useEffect(() => {
    if (showing.kind !== "beat") return;
    if (snapshot.loop.src && snapshot.loop.src !== showing.loopSrc) setShowing({ kind: "loop" });
  }, [snapshot.loop.src, showing]);

  const beat = showing.kind === "beat"
    ? snapshot.beats.find((candidate) => candidate.id === showing.beatId) ?? null
    : null;
  // The loop is held the whole time, not swapped out when a beat is chosen:
  // a beat's bytes still have to arrive, and dropping the loop during that
  // download is exactly the blank frame this design exists to avoid.
  const beatSource = useSegmentSource(beat?.media.src ?? null, fetchClip);
  const loopSource = useSegmentSource(snapshot.loop.src, fetchClip);

  return <div className="player-card escape-room" aria-label="Escape room">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">ESCAPE ROOM · {snapshot.title.toUpperCase()}</p>
        <h2>{snapshot.location.name}</h2>
      </div>
      <span className="playback-status" role="status">
        {snapshot.ended ? "SESSION OVER" : `TURN ${snapshot.turn.index}`}
      </span>
    </div>

    <div className="player-frame">
      {beat && beatSource
        ? <video
            key={beat.id}
            src={beatSource}
            ref={hold(screen)}
            onCanPlay={(event) => startPlaying(event.currentTarget)}
            autoPlay
            muted
            playsInline
            loop
            data-testid="escape-beat"
          />
        : loopSource
          ? <video
              key={`loop-${snapshot.loop.src ?? snapshot.location.id}`}
              src={loopSource}
              ref={hold(screen)}
              onCanPlay={(event) => startPlaying(event.currentTarget)}
              autoPlay
              muted
              loop
              playsInline
              data-testid="escape-loop"
            />
          : <p className="player-placeholder">{loopPlaceholder(snapshot.loop)}</p>}
    </div>

    <p className="form-note">{snapshot.location.description}</p>
    {beat && <p className="form-note" aria-live="polite">{beat.narration}</p>}
    {snapshot.ended && <Notice>{snapshot.ended.tell}</Notice>}

    <Progress snapshot={snapshot} />

    {!snapshot.ended && <div className="queue-card queue-card-stack">
      <div>
        <p className="eyebrow">WHAT DOES {snapshot.characterName.toUpperCase()} DO?</p>
        <h2>{snapshot.turn.proposals.length === 0 ? "Nothing proposed yet." : `${snapshot.turn.voters} vote${snapshot.turn.voters === 1 ? "" : "s"} cast`}</h2>
      </div>
      <ul className="roster escape-proposals">
        {snapshot.turn.proposals.map((proposal) => <li key={proposal.id}>
          <span className="roster-dot" />
          <span>{proposal.body} <em>— {proposal.authorName}, {proposal.votes} vote{proposal.votes === 1 ? "" : "s"}</em></span>
          <button
            className={`button ${snapshot.turn.yourVote === proposal.id ? "button-primary" : "button-quiet"}`}
            disabled={!canContribute || busy}
            onClick={() => void actions.vote(proposal.id)}
          >
            {snapshot.turn.yourVote === proposal.id ? "Your vote" : "Vote"}
          </button>
        </li>)}
      </ul>
      <form
        className="contribution-form"
        onSubmit={(event) => {
          event.preventDefault();
          const said = draft.trim();
          if (!said) return;
          setDraft("");
          void actions.propose(said, displayName);
        }}
      >
        <label className="sr-only" htmlFor="escape-proposal">Say what {snapshot.characterName} does next</label>
        <textarea
          id="escape-proposal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say what happens next, in your own words…"
          maxLength={280}
          disabled={!canContribute || busy}
        />
        <button className="button button-primary" type="submit" disabled={!canContribute || busy}>
          Propose <span>↗</span>
        </button>
      </form>
      {isHost && <div className="hero-actions">
        <button
          className="button button-primary"
          disabled={busy || snapshot.turn.proposals.length === 0}
          onClick={() => void actions.settle()}
        >
          Close the vote
        </button>
      </div>}
      <p className="form-note">
        The winning proposal is resolved by this room's rules and filmed. The others are
        discarded, not queued.
      </p>
    </div>}

    <BeatLog beats={snapshot.beats} />
    <Spend snapshot={snapshot} />
    {failure && <Notice>{failure}</Notice>}
  </div>;
}

/**
 * Asks the element to play as soon as it exists.
 *
 * `autoPlay` on a muted video is meant to be enough, and measured in a real
 * browser it was not: the element sat on its first frame, which is exactly
 * the dead screen this design exists to avoid. So it is asked twice — when
 * the element appears, and again when it says it can play, since the first
 * ask can land on a source that has not loaded or an element React is about
 * to re-attach. Asking an already-playing element to play does nothing.
 *
 * The rejection is ignored: a browser that refuses autoplay is showing the
 * first frame, not raising an error worth saying out loud.
 */
/** Records the element that currently has the screen, and starts it. */
function hold(screen: { current: HTMLVideoElement | null }) {
  return (element: HTMLVideoElement | null) => {
    screen.current = element;
    startPlaying(element);
  };
}

function startPlaying(element: HTMLVideoElement | null): void {
  // `play()` returns a promise in a browser and nothing at all in a document
  // that does not implement playback, so neither is assumed here.
  const played = element?.play() as Promise<void> | undefined;
  if (played) void played.catch(() => undefined);
}

/** What has been found and what is still shut, counted from scenario state. */
function Progress({ snapshot }: { snapshot: EscapeSnapshot }) {
  const { progress } = snapshot;
  return <div className="queue-card queue-card-stack escape-progress">
    <div>
      <p className="eyebrow">THE GOAL</p>
      <h2>{progress.goalDescription}</h2>
    </div>
    <p className="form-note">
      {progress.stepsTaken} thing{progress.stepsTaken === 1 ? " has" : "s have"} happened.{" "}
      {progress.goalReached ? "It is done." : `${progress.shut.length} still in the way.`}
    </p>
    <ul className="roster">
      {progress.found.length === 0 && <li><span className="roster-dot" /><span>Nothing found yet.</span></li>}
      {progress.found.map((thing) => <li key={thing.id}>
        <span className={`roster-dot${thing.here ? " online" : ""}`} />
        <span>{thing.name} — {thing.stateLabel}{progress.carrying.some((held) => held.id === thing.id) ? " · carried" : ""}</span>
      </li>)}
    </ul>
  </div>;
}

/** Everything the room has done, newest last, with what became of the film. */
function BeatLog({ beats }: { beats: readonly BeatView[] }) {
  if (beats.length === 0) return null;
  return <ol className="contribution-list" aria-label="What happened">
    {beats.map((beat) => <article className={`contribution ${beat.outcome === "advanced" ? "director" : "host"}`} key={beat.id}>
      <span>
        {beat.outcome === "advanced" ? "happened" : beat.outcome === "failed" ? "refused" : "not possible"}
        {" · "}{mediaLabel(beat.media)}
        {beat.narrationSource === "scenario" && beat.outcome === "advanced" ? " · told by the scenario" : ""}
      </span>
      <p>{beat.narration}</p>
      {beat.proposal && <p className="form-note">“{beat.proposal.body}” — {beat.proposal.authorName}</p>}
    </article>)}
  </ol>;
}

/** Real money, committed against the ceiling this server already documents. */
function Spend({ snapshot }: { snapshot: EscapeSnapshot }) {
  return <p className="form-note">
    {snapshot.spend.budgetUsd > 0
      ? `Committed $${snapshot.spend.committedUsd.toFixed(2)} of this server's $${snapshot.spend.budgetUsd.toFixed(2)} ceiling.`
      : "This server has no generation budget configured, so nothing can be generated."}
    {snapshot.mediaDurable ? "" : " Generated shots are held in memory and are lost if this server restarts."}
  </p>;
}

function mediaLabel(media: SegmentView): string {
  if (media.status === "ready") {
    return media.seconds === null ? "filmed" : `filmed, ${media.seconds.toFixed(1)}s`;
  }
  if (media.status === "generating") return "filming";
  if (media.status === "failed") return "not filmed";
  if (media.status === "forgotten") return "filmed, no longer held";
  if (media.status === "ceiling_reached") return "past the spend ceiling";
  if (media.status === "not_configured") return "no video on this server";
  return "not filmed";
}

function loopPlaceholder(loop: SegmentView): string {
  if (loop.message) return loop.message;
  if (loop.status === "generating") return "Filming the room for the first time — about ten seconds.";
  return "There is no footage of this room yet.";
}
