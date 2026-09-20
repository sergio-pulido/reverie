import { useMemo, useState, type ReactNode } from "react";
import { Footer, Notice } from "../chrome";
import { formatClock } from "../core/clock";
import {
  buildTimeline,
  directionTurns,
  firstBlockedBeat,
  type TimelineBeat,
} from "../core/directorTimeline";
import { budgetSpent, formatUsd } from "../core/directorSpend";
import { totalDurationSeconds } from "../core/script";
import { readJamConfiguration } from "../lib/jamConfiguration";
import { TopBar } from "../shell/TopBar";
import { useRows, type Row } from "../shell/useRows";
import { BEAT_STATE_LABEL, BEAT_STATE_MEANING } from "./beatLabels";
import { DeliverablesDrawer } from "./DeliverablesDrawer";
import { deliverablesOf } from "./deliverables";
import { DirectionColumn } from "./DirectionColumn";
import { COMPOSER_ROW, DirectorComposer } from "./DirectorComposer";
import { MODE_LABEL, MODE_MEANING, type DirectorMode } from "./mode";
import { Stage, STAGE_ROW } from "./Stage";
import { TIMELINE_ROW, Timeline } from "./Timeline";
import { TransportBar, TRANSPORT_ROW } from "./TransportBar";
import { useDirectorFilm } from "./useDirectorFilm";
import { useDirectorSession } from "./useDirectorSession";
import { usePlaybackClock } from "./usePlaybackClock";

/**
 * A Director session: one person making one film by talking to it.
 *
 * Three zones. The stage is the frame and what it is doing. The timeline is
 * every beat of the film, in order, each saying whether it can still change.
 * The direction column is the turns, and each turn wears the state of the beat
 * it steered — resting on either end lights the other, which is the whole idea
 * the screen is built around: you can see, at a glance, which of the things
 * you asked for are still yours to take back.
 *
 * Everything drawn here comes from something this product knows: the script's
 * own beats and durations, the stream's own audit trail, and the server's own
 * budget. Where there is nothing to know, the screen says so.
 */
export function DirectorScreen({ slug }: { slug: string | null }) {
  const film = useDirectorFilm(slug);
  const room = film.phase === "ready" ? film.room : null;
  const jam = film.phase === "ready" ? film.jam : null;
  const jamId = room?.id ?? null;

  const configuration = useMemo(() => (jamId ? readJamConfiguration(jamId) : null), [jamId]);
  const session = useDirectorSession(jamId, configuration);
  const script = jam?.script ?? null;
  const runtimeSeconds = script ? totalDurationSeconds(script) : 0;
  const clock = usePlaybackClock(jamId, runtimeSeconds);

  const [mode, setMode] = useState<DirectorMode>("direct");
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const beats = useMemo(
    () =>
      script
        ? buildTimeline(script, {
            window: session.beats,
            producedThrough: session.producedThrough,
            spend: session.spend,
          })
        : [],
    [script, session.beats, session.producedThrough, session.spend],
  );
  const turns = useMemo(() => directionTurns(session.audit, script), [session.audit, script]);

  const currentBeatIndex = session.beats?.currentBeatIndex ?? null;
  const currentBeat = currentBeatIndex === null ? null : beats[currentBeatIndex] ?? null;
  const blockedBeat = firstBlockedBeat(beats);
  // Playing and stopping the stream belong to whoever can open this jam: the
  // take is the room's, not one person's. The room's playback clock is a
  // different thing — the database lets only the host move it — so it keeps
  // its own answer rather than riding on this one.
  const movesTheClock = film.phase === "ready" ? film.isHost : false;

  const rows: Row[] = [
    { key: STAGE_ROW, count: 2 },
    { key: TRANSPORT_ROW, count: session.recording && clock.available ? 2 : 0 },
    { key: TIMELINE_ROW, count: beats.length },
    { key: COMPOSER_ROW, count: 3 },
  ];
  const { containerRef, cellProps, onKeyDown, onFocus } = useRows(rows);

  if (film.phase === "loading") {
    return (
      <Shell>
        <header className="director-head">
          <p className="eyebrow">DIRECTOR</p>
          <h1>Opening the session…</h1>
        </header>
      </Shell>
    );
  }
  if (film.phase === "error") {
    return (
      <Shell>
        <header className="director-head">
          <p className="eyebrow">DIRECTOR</p>
          <h1>This session is not open to you.</h1>
          <p className="intro">{film.message}</p>
        </header>
      </Shell>
    );
  }

  const cannotStart = startRefusal({
    configured: session.configured,
    spent: budgetSpent(session.spend),
    hasScript: script !== null,
    scriptMissing: film.scriptMissing,
  });

  return (
    <Shell>
      <header className="director-head">
        <div>
          <p className="eyebrow">DIRECTOR SESSION</p>
          <h1>{script?.title ?? room?.title ?? "Untitled"}</h1>
          <p className="intro">
            {script?.logline ?? room?.premise ?? "One person, one film, one conversation."}
          </p>
        </div>
        <Spend
          sessionUsd={session.spend.sessionUsd}
          budgetUsd={session.spend.budgetUsd}
          remainingUsd={session.spend.remainingUsd}
          generatedSeconds={session.state.generatedSeconds}
        />
      </header>

      {film.persistence === "preview" && (
        <Notice tone="status">
          Supabase is not configured, so this jam is a browser-only preview registration.
        </Notice>
      )}
      {session.failure && <Notice>{session.failure}</Notice>}
      {session.state.error && <Notice>{session.state.error}</Notice>}

      <div
        className="director-grid"
        ref={(element) => {
          containerRef.current = element;
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="director-column-stage">
          <Stage
            session={session}
            beats={beats}
            currentBeat={currentBeat}
            cannotStart={cannotStart}
            cellProps={cellProps}
            transport={
              <TransportBar
                clock={clock}
                beats={beats}
                runtimeSeconds={runtimeSeconds}
                canDrive={movesTheClock}
                cellProps={cellProps}
              />
            }
          />

          {/* The most prominent control after the stage, as the two modes are
              the one choice that changes what everything below it does. */}
          <div className="director-modes" role="group" aria-label="How you are working">
            {(["direct", "review"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="director-mode"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
              >
                <span className="director-mode-label">{MODE_LABEL[option]}</span>
                <span className="director-mode-meaning">{MODE_MEANING[option]}</span>
              </button>
            ))}
          </div>

          <Timeline
            beats={beats}
            runtimeSeconds={runtimeSeconds}
            highlighted={highlighted}
            selected={selected}
            onHighlight={setHighlighted}
            onSelect={setSelected}
            cellProps={cellProps}
            emptyReason={film.scriptMissing}
          />
          <Legend />
          {mode === "review" && (
            <ReviewTools
              beat={selected === null ? null : beats[selected] ?? null}
              live={session.live}
            />
          )}
        </div>

        <div className="director-column-direction">
          <DirectionColumn
            turns={turns}
            beats={beats}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            onSelect={setSelected}
            live={session.live}
          />
          <DirectorComposer
            mode={mode}
            onDirect={session.direct}
            targetBeat={selected}
            onClearTarget={() => setSelected(null)}
            notes={composerNotes({
              live: session.live,
              cannotStart,
              blockedBeatNumber: blockedBeat?.number ?? null,
              remainingUsd: session.spend.remainingUsd,
              budgetUsd: session.spend.budgetUsd,
            })}
            blocked={!session.live}
            cellProps={cellProps}
          />
          <DeliverablesDrawer
            items={deliverablesOf({
              jamId,
              script,
              scriptMissing: film.scriptMissing,
              live: session.live,
              recording: session.recording,
              recordingDurable: session.recordingDurable,
            })}
          />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="site-shell director-shell">
      <TopBar current="jam" />
      {children}
      <Footer />
    </main>
  );
}

/**
 * What this session has cost, against the ceiling the server is configured
 * with. Both figures are real: the bill comes from the seconds the provider
 * generated, the ceiling from `FAL_ASSET_BUDGET_USD`.
 */
function Spend({
  sessionUsd,
  budgetUsd,
  remainingUsd,
  generatedSeconds,
}: {
  sessionUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  generatedSeconds: number;
}) {
  const share = budgetUsd > 0 ? Math.min(1, sessionUsd / budgetUsd) : 0;
  return (
    <div className="director-spend" aria-label="What this session has spent">
      <p className="eyebrow">SPENT</p>
      <p className="director-spend-figure">
        {formatUsd(sessionUsd)}
        <span className="director-spend-ceiling"> of {formatUsd(budgetUsd)}</span>
      </p>
      <div className="director-spend-bar" aria-hidden="true">
        <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
      </div>
      <p className="director-spend-note">
        {budgetUsd > 0
          ? `${formatClock(generatedSeconds)} generated · ${formatUsd(remainingUsd)} left`
          : "No director budget is configured on this server, so nothing can be generated."}
      </p>
    </div>
  );
}

/** What the timeline's treatments mean, stated once rather than guessed at. */
function Legend() {
  return (
    <ul className="director-legend" aria-label="What a beat's state means">
      {(["written", "generating", "ready", "locked", "blocked"] as const).map((state) => (
        <li key={state} data-state={state}>
          <span className="director-legend-swatch" aria-hidden="true" />
          <strong>{BEAT_STATE_LABEL[state]}</strong> {BEAT_STATE_MEANING[state]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Review's per-beat tools.
 *
 * Re-directing a beat is real: the server takes a direction with a beat index
 * and refuses it when the beat has closed. Variants are not — nothing in this
 * build generates a second take of a beat, keeps one, or chooses between
 * them — so the panel says that rather than drawing an empty carousel.
 */
function ReviewTools({ beat, live }: { beat: TimelineBeat | null; live: boolean }) {
  return (
    <section className="director-review" aria-label="Beat tools">
      <p className="eyebrow">THIS BEAT</p>
      {beat === null ? (
        <p className="director-empty-line">Choose a beat on the timeline to work on it.</p>
      ) : (
        <>
          <h2>
            Beat {beat.number} · {beat.durationSeconds}s · {BEAT_STATE_LABEL[beat.state]}
          </h2>
          <p className="director-zone-note">
            {beat.summary ?? "This beat has no phrase: nothing has written one for it. An imported script carries none."}
          </p>
          <p className="director-zone-note">
            {beat.state === "locked" || beat.state === "generating" || beat.state === "ready"
              ? "This beat is already with the provider. Direction aimed at it will be refused; the beats after it can still change."
              : live
                ? "Direction sent while this beat is chosen is aimed at it."
                : "The stream is stopped. Play it to change this beat."}
          </p>
        </>
      )}
      <p className="director-zone-note">
        No variants: nothing in this build generates a second take of a beat, so there is none to
        compare. No reference library either — this session keeps no images or clips, because
        there is nowhere to keep them.
      </p>
    </section>
  );
}

/** Why a session cannot be opened at all, or null when it can. */
function startRefusal({
  configured,
  spent,
  hasScript,
  scriptMissing,
}: {
  configured: boolean;
  spent: boolean;
  hasScript: boolean;
  scriptMissing: string | null;
}): string | null {
  if (!hasScript) return scriptMissing ?? "There is no script to generate from.";
  if (!configured) return "The live director is not configured on this server.";
  if (spent) return "The director budget for this server is spent. No further beat can be generated.";
  return null;
}

/**
 * What the composer says under the field.
 *
 * Two different facts, and both can hold at once: whether anything can be sent
 * at all, and what the budget will no longer pay for. Collapsing them into one
 * line is how "the budget is out" ends up hidden behind "the stream is
 * stopped", which is the one thing the viewer most needs told.
 */
function composerNotes({
  live,
  cannotStart,
  blockedBeatNumber,
  remainingUsd,
  budgetUsd,
}: {
  live: boolean;
  cannotStart: string | null;
  blockedBeatNumber: number | null;
  remainingUsd: number;
  budgetUsd: number;
}): string[] {
  const notes: string[] = [];
  if (!live) {
    notes.push(cannotStart ?? "The stream is stopped. Play it, and what you say reaches it.");
  }
  if (budgetUsd <= 0) {
    notes.push("No director budget is configured on this server, so no beat can be generated.");
  } else if (remainingUsd <= 0) {
    notes.push("The director budget is spent. No further beat can be generated.");
  } else if (blockedBeatNumber !== null) {
    notes.push(
      `Only ${formatUsd(remainingUsd)} of the director budget is left, so beat ${blockedBeatNumber} onward is blocked.`,
    );
  }
  return notes;
}
