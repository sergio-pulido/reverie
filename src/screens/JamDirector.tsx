import { useCallback, useEffect, useRef, useState } from "react";
import { hasRecording, lifecycleLabel, type JamLifecycle } from "../core/jamLifecycle";
import {
  directorArchivePlaylistSrc,
  readArchiveToken,
  type ArchivedFilm,
  listDirectorArchive,
  readDirectorArchive,
  readJamLifecycle,
  type ArchivedPiece,
} from "../lib/directorSession";
import { Notice } from "../chrome";
import {
  initialDirectorState,
  type DirectorState,
} from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
import { formatUsd, type DirectorSpend } from "../core/directorSpend";
import { formatClock } from "../core/clock";
import type { SessionSettings } from "../core/session";
import { attachHlsStream, type HlsAttachment } from "../lib/hlsPlayback";
import {
  attachDirectorSession,
  directorPlaylistSrc,
  directorRecordingSrc,
  DirectorSessionError,
  endDirectorSession,
  readDirectorBudget,
  readDirectorSession,
  renewDirectorSession,
  startDirectorSession,
  watchDirectorStream,
  type DirectorBudget,
  type OpenedDirectorSession,
} from "../lib/directorSession";

type JamDirectorProps = {
  jamId: string;
  /** Viewers on the same configuration share one stream. */
  configuration: SessionSettings | null;
};

const POLL_MS = 2_000;
const RENEW_MS = 30_000;
/** How often a room that is not yet streaming checks whether it has started. */
const ATTACH_MS = 3_000;

/**
 * The live director: one continuous MiniMax H3 Max stream the room directs.
 *
 * The stream itself lives on the server, which is the WebRTC peer. This screen
 * never touches the provider — it asks the server to send direction and reads
 * back what happened. The recording is what you watch, and the audit trail is
 * what you check it against.
 *
 * Everybody in the room gets the same two signals, play and stop, and the same
 * direction box. Nobody owns the stream: whoever is looking at the room can
 * start the take, and whoever is looking at it can stop the take. That is why
 * this screen also has to notice a session vanishing under it — the person who
 * stopped it may well be somebody else.
 */
export function JamDirector({ jamId, configuration }: JamDirectorProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<DirectorState>(initialDirectorState);
  const [audit, setAudit] = useState<DirectorAuditEntry[]>([]);
  const [durable, setDurable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  /** The finished film's pieces, so a viewer can go straight to a minute. */
  const [pieces, setPieces] = useState<ArchivedPiece[]>([]);
  const [archivedSession, setArchivedSession] = useState<string | null>(null);
  /** Every take this room has archived, newest first. */
  const [films, setFilms] = useState<ArchivedFilm[]>([]);
  /** Why the open take has no film, when it has none. */
  const [filmNotice, setFilmNotice] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const [beats, setBeats] = useState<DirectorBeatWindow | null>(null);
  const [attached, setAttached] = useState(false);
  /**
   * Looking for the take this room is already running.
   *
   * Entering a room asks the server what it is playing, and until that
   * answers, whether there is anything to join is unknown. Play is not offered
   * in that moment: it would offer to open — and pay for — a second take of
   * the film the room may already be watching.
   */
  const [joining, setJoining] = useState(true);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [liveDelivery, setLiveDelivery] = useState(false);
  const [playbackFailure, setPlaybackFailure] = useState<string | null>(null);
  // What the take is costing, as the server counts it. Read on every poll and
  // on every open, because a per-second bill that is only visible afterwards
  // is not a spend control anybody can act on.
  const [spend, setSpend] = useState<DirectorSpend | null>(null);
  /** What this server will spend at all, read before anything is spent. */
  const [budget, setBudget] = useState<DirectorBudget | null>(null);
  /** Where a take stops itself; the budget route says so before the first one. */
  const [maxSeconds, setMaxSeconds] = useState<number | null>(null);
  /** The relay could not be attached: the take runs, this screen cannot show it. */
  const [relayFailure, setRelayFailure] = useState<string | null>(null);
  // The room's life, as the server holds it. Read on mount so a reopened tab
  // shows a stopped room as stopped, then kept current by play and stop.
  const [lifecycle, setLifecycle] = useState<JamLifecycle>("live");
  const live = sessionId !== null;
  const active = useRef<{ sessionId: string; viewerId: string | null } | null>(null);
  const starting = useRef(false);
  const screen = useRef<HTMLVideoElement | null>(null);
  /** The finished film's element; the live take and the archive never share one. */
  const film = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    active.current = sessionId ? { sessionId, viewerId } : null;
  }, [sessionId, viewerId]);

  /** Takes up a stream this viewer has just opened or joined. */
  const adopt = useCallback((opened: OpenedDirectorSession) => {
    // The previous take's recording is what a stopped room shows. A new take —
    // this viewer's, or one somebody else started — replaces it, and leaving it
    // set would blank the frame: the player renders the recording or the live
    // stream, never both.
    setRecording(null);
    setSessionId(opened.sessionId);
    setViewerId(opened.viewerId ?? null);
    setLiveDelivery(opened.liveDelivery ?? false);
    setState(opened.state);
    setBeats(opened.beats);
    setAttached(opened.attached);
    setDurable(opened.recordingDurable);
    setSpend(opened.spend);
    setMaxSeconds(opened.maxSessionSeconds);
  }, []);

  /** Goes to a moment of the finished film, in the film that is already open. */
  const seekFilm = useCallback((startSeconds: number) => {
    const video = film.current;
    if (!video) return;
    video.currentTime = startSeconds;
    // A browser that refuses to start playing from a jump is not a failure
    // worth reporting: the frame is where it was asked to be, and the viewer
    // has the controls. Guarded rather than awaited for the same reason.
    try {
      void video.play()?.catch(() => undefined);
    } catch {
      /* nothing to say */
    }
  }, []);

  /**
   * Plays the finished film.
   *
   * The same HLS attachment as the live take, in its VOD mode: the archive
   * playlist lists every piece and its duration, so the player can seek
   * through the film instead of downloading it to reach a minute.
   *
   * It carries the viewer's access token, because in production these routes
   * are Vercel functions that check membership and read Supabase as the
   * caller. A plain `<video src>` cannot present one, which is why the film
   * goes through the player here rather than straight into the element.
   */
  useEffect(() => {
    if (live || !recording) return;
    let attachment: HlsAttachment | null = null;
    let cancelled = false;
    setPlaybackFailure(null);
    void readArchiveToken()
      .then((accessToken) => {
        if (cancelled || !film.current) return;
        attachment = attachHlsStream(film.current, recording, {
          ...(accessToken ? { accessToken } : {}),
          vod: true,
          onFailure: setPlaybackFailure,
        });
      })
      .catch(() => {
        setPlaybackFailure("This session could not be verified, so the film stayed closed.");
      });
    return () => {
      cancelled = true;
      attachment?.detach();
    };
  }, [live, recording]);

  /**
   * Plays the shared stream.
   *
   * The playlist is the same address for everyone watching this configuration,
   * so a second viewer costs a cache hit rather than a second paid session.
   */
  useEffect(() => {
    const video = screen.current;
    if (!video || !sessionId || !liveDelivery) return;
    setPlaybackFailure(null);
    const attachment = attachHlsStream(video, directorPlaylistSrc(jamId, sessionId), {
      onFailure: setPlaybackFailure,
    });
    return () => attachment.detach();
  }, [jamId, liveDelivery, sessionId]);

  /**
   * Joins a stream that is already running.
   *
   * Opening a jam where the room is watching something should show the film,
   * not a button. This never starts one: starting bills a sixty-second
   * minimum, so walking into a room must not be able to spend that. Arriving
   * attaches to what is already running or waits for somebody to press Play,
   * which is also how whoever started it rejoins after reopening the jam.
   */
  useEffect(() => {
    if (sessionId) return;
    let cancelled = false;
    let inFlight = false;
    const join = async () => {
      if (inFlight || starting.current) return;
      inFlight = true;
      try {
        const opened = await attachDirectorSession(jamId, configuration);
        if (cancelled) {
          // Attaching changes server state by allocating a viewer id. A request
          // that finishes after unmount (including React's development remount)
          // must undo that allocation instead of leaving a phantom viewer to
          // keep the paid stream alive until the idle timeout.
          void endDirectorSession(jamId, opened.sessionId, opened.viewerId).catch(
            () => undefined,
          );
          return;
        }
        adopt(opened);
      } catch {
        // `no_stream` is the ordinary answer before somebody presses Play.
      } finally {
        inFlight = false;
        // Answered, either way: the room has said whether it is playing, so
        // this screen can stop holding its offer back.
        if (!cancelled) setJoining(false);
      }
    };
    void join();
    const poll = setInterval(() => void join(), ATTACH_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // `configuration` is memoized per jam by the studio, so this does not
    // re-attach on every render; the server normalizes it, so two settings that
    // differ only cosmetically resolve to the same stream there regardless.
  }, [adopt, configuration, jamId, sessionId]);

  /**
   * Reads the room's life, and finds the recording of its last take.
   *
   * Read on mount so a reopened tab shows a stopped room as stopped, and read
   * again whenever the live session disappears — anybody in the room can stop
   * it, so this screen learns about most stops from the server rather than
   * from its own button.
   */
  /**
   * Opens one archived take.
   *
   * A session row exists from the moment a take starts, so a take that stored
   * nothing — recording switched off, or no media track ever arrived — has a
   * record and no film. That is said rather than rendered as an empty frame:
   * a screen that silently shows nothing is indistinguishable from one that is
   * broken, and this one was.
   */
  const openFilm = useCallback(
    async (film: ArchivedFilm) => {
      setArchivedSession(film.id);
      const detail = await readDirectorArchive(jamId, film.id);
      const storedPieces = detail.segments ?? [];
      setPieces(storedPieces);
      if (storedPieces.length === 0) {
        setRecording(null);
        setFilmNotice("This take recorded no video, so there is nothing to play back.");
        return;
      }
      setFilmNotice(null);
      setRecording(directorArchivePlaylistSrc(jamId, film.id));
    },
    [jamId],
  );

  const readRoom = useCallback(async () => {
    // Best effort, and deliberately not fatal. The room's life is held by the
    // container that runs the take; the archive is read from Supabase by a
    // deployed function. A deployment that has the second and not the first —
    // which is what production is — must still show the film it made, so a
    // lifecycle that cannot be read means "unknown", not "nothing to show".
    const current = await readJamLifecycle(jamId).catch(() => null);
    if (current) {
      setLifecycle(current);
      if (!hasRecording(current)) return;
    }
    const archive = await listDirectorArchive(jamId);
    // Every take the room has made, not only the last one. A room that has
    // played three times has three films, and showing one of them was how two
    // of them became invisible.
    setFilms(archive.sessions);
    // Newest first, so the room's last take is the one already open.
    const latest = archive.sessions[0];
    if (latest) await openFilm(latest);
  }, [jamId, openFilm]);

  useEffect(() => {
    void readRoom().catch(() => {
      // The room still works without this; it just starts from `live`.
    });
  }, [readRoom]);

  /**
   * What this server will spend, before anybody presses anything.
   *
   * Without it the first thing a reader learns about a server with no director
   * configured is a refusal, and the first thing they learn about the price is
   * the bill. Both are knowable up front, so both are said up front.
   */
  useEffect(() => {
    let cancelled = false;
    void readDirectorBudget(jamId)
      .then((current) => {
        if (cancelled) return;
        setBudget(current);
        setMaxSeconds((known) => known ?? current.maxSessionSeconds);
        setSpend((known) => known ?? current.spend);
      })
      .catch(() => {
        // An unreadable budget is not a reason to hide the room; the refusal
        // on press still says what happened.
      });
    return () => {
      cancelled = true;
    };
  }, [jamId]);

  // Polling is the surface until Realtime events land, matching the player.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snapshot = await readDirectorSession(jamId, sessionId);
        if (cancelled) return;
        setState(snapshot.state);
        setAudit(snapshot.audit);
        setBeats(snapshot.beats);
        setSpend(snapshot.spend);
      } catch (error) {
        if (cancelled) return;
        // Somebody else stopped it, or the server reclaimed it. This screen is
        // now polling a session that no longer exists, so it lets go of it and
        // shows what the room actually has — the recording of that take, and a
        // play button that opens the next one.
        if (error instanceof DirectorSessionError && error.code === "not_found") {
          setSessionId(null);
          setViewerId(null);
          void readRoom().catch(() => undefined);
        }
      }
    };
    void tick();
    const poll = setInterval(() => void tick(), POLL_MS);
    const renew = setInterval(
      () => renewDirectorSession(jamId, sessionId, viewerId ?? undefined),
      RENEW_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(renew);
    };
  }, [jamId, readRoom, sessionId, viewerId]);

  // Watch it as it is generated rather than waiting for the recording. The
  // browser peers with our server, which is already holding the provider
  // connection, so nothing here talks to fal.
  useEffect(() => {
    // The server says which delivery it offers; the relay is the default and
    // HLS displaces it only where it is switched on.
    if (!sessionId || liveDelivery) return;
    let cancelled = false;
    setRelayFailure(null);
    void watchDirectorStream(jamId, sessionId, (stream) => {
      if (video.current) video.current.srcObject = stream;
    })
      .then((close) => {
        if (cancelled) close();
        else detach.current = close;
      })
      .catch(() => {
        if (cancelled) return;
        // Live viewing is an addition, not the session: a viewer that cannot
        // attach still has state, the audit trail and the recording. Saying so
        // is the point — an empty frame under a PLAYING badge otherwise reads
        // as a take that is not running, and the difference decides whether
        // somebody presses Stop.
        setRelayFailure(
          "This screen could not attach to the live stream. The take is still running and still being recorded.",
        );
      });
    return () => {
      cancelled = true;
      detach.current?.();
      detach.current = null;
      if (video.current) video.current.srcObject = null;
    };
  }, [jamId, liveDelivery, sessionId]);

  // A stream left open keeps billing, so this viewer leaves it when this
  // unmounts — which ends it only if nobody else is still watching.
  useEffect(
    () => () => {
      const open = active.current;
      // Leaving is always a detach, never an outright end. An `/end` with no
      // viewer id stops the stream for the whole room, and closing a tab is
      // not a claim to do that — only the deliberate Stop is, whoever presses
      // it. The count is what keeps the paid stream honest: it outlives the
      // person who started it and ends when the last watcher leaves. A viewer
      // with nothing to detach must send nothing rather than end the film
      // everyone else is watching.
      if (open?.viewerId) {
        void endDirectorSession(jamId, open.sessionId, open.viewerId).catch(
          () => undefined,
        );
      }
    },
    [jamId],
  );

  const start = useCallback(async () => {
    starting.current = true;
    setBusy(true);
    setFailure(null);
    setRecording(null);
    try {
      const opened = await startDirectorSession(jamId, configuration);
      adopt(opened);
      setLifecycle(opened.lifecycle);
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "The live director could not be started.",
      );
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }, [adopt, configuration, jamId]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setFailure(null);
    try {
      // Stop ends the stream for the room, so it names no viewer. Leaving as a
      // viewer is what closing the screen does; this is the deliberate end of
      // the take, and anybody in the room may send it. The room stays: it can
      // be played again, and this take keeps its own recording.
      const stopped = await endDirectorSession(jamId, sessionId);
      setLifecycle(stopped.lifecycle);
      // The pieces land as the muxer finishes them, so this reads what is there
      // now — and re-reads the shelf, because the take that just stopped is a
      // film the room did not have a moment ago.
      void readRoom().catch(() => undefined);
    } catch (error) {
      // Ending is idempotent server-side, so this is rarely a real failure —
      // but the one time it is, a paid take is still running and the reader is
      // the only one who can do anything about it. Saying nothing was the
      // wrong trade for the one failure on this screen that costs money.
      setFailure(
        error instanceof DirectorSessionError
          ? `${error.message} The take may still be running; try Stop again.`
          : "That stop did not reach the server. The take may still be running; try Stop again.",
      );
    } finally {
      setSessionId(null);
      setViewerId(null);
      setBusy(false);
    }
  }, [jamId, readRoom, sessionId]);

  return <div className="player-card" aria-label="Live director">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">LIVE DIRECTOR</p>
        <h2>Direct it while it runs.</h2>
      </div>
      <span className="playback-status" role="status" data-testid="jam-lifecycle">
        {badge(state, busy, live, lifecycle)}
      </span>
    </div>

    <div className="player-frame">
      {!live && recording ? (
        <video
          ref={film}
          controls
          playsInline
          data-testid="jam-director-recording"
          // The film is attached through the player rather than set as a src,
          // so this is what says which film is on screen — to a reader, and to
          // a test that cannot run a media pipeline.
          data-film={recording}
        />
      ) : null}
      {!recording && live && liveDelivery ? (
        <video
          ref={screen}
          autoPlay
          muted
          playsInline
          controls
          data-testid="jam-director-live"
        />
      ) : null}
      {/*
        * The relay's element is kept mounted rather than conditionally
        * rendered, because its srcObject is set by an effect that would
        * otherwise race the element into existence.
        */}
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        hidden={!live || liveDelivery}
        data-testid="jam-director-relay"
      />
      {!live && recording && archivedSession && pieces.length > 1 && (
        <PieceJump
          pieces={pieces}
          onJump={(startSeconds) => seekFilm(startSeconds)}
          onWhole={() => seekFilm(0)}
        />
      )}
      {!live && !recording && (
        <p className="player-placeholder">
          {filmNotice ?? placeholder(state, live, lifecycle, joining)}
        </p>
      )}
    </div>
    {/*
      * Every take this room has made, so the ones before the last one are
      * reachable. A room plays more than once — that is the point of a room
      * that is never retired — and each take keeps its own film.
      */}
    {!live && films.length > 0 && (
      <FilmShelf
        films={films}
        openId={archivedSession}
        onOpen={(film) => void openFilm(film).catch(() => undefined)}
      />
    )}
    {playbackFailure ? <Notice tone="alert">{playbackFailure}</Notice> : null}
    {relayFailure ? <Notice tone="status">{relayFailure}</Notice> : null}

    <p className="form-note" aria-live="polite" data-testid="jam-director-status">
      {statusLine(state, live, busy, lifecycle, joining)}
    </p>
    {live && beats && <BeatWindow beats={beats} attached={attached} />}

    {/*
      * Two signals, play and stop, and both belong to whoever is in the room.
      * Nobody owns the take: a room where only one person could start it left
      * everyone who joined watching a button they could not press, and made
      * the stream depend on that one person staying. The cost of the take is
      * stated below rather than fenced off behind a role.
      */}
    {/*
      * The emphasis follows the take. While nothing is running the offer is
      * Play; once it is running the only thing worth pressing — and the one
      * that stops the per-second bill — is Stop, so Stop is what the eye lands
      * on and Play recedes to a disabled label saying what is happening.
      *
      * Entering the room is the third case. Until the server has said what
      * this room is playing there is no offer to make: a room that is already
      * playing should hand you the film, and a Play pressed in that moment
      * would have opened a second paid take of it.
      */}
    <div className="hero-actions">
      <button
        className={live || joining ? "button button-quiet" : "button button-primary"}
        onClick={() => void start()}
        disabled={busy || live || joining}
        data-testid="jam-director-play"
      >
        {busy && !live
          ? "Starting…"
          : live
            ? "Playing"
            : joining
              ? "Joining…"
              : "Play"}{" "}
        <span>▶</span>
      </button>
      <button
        className={live ? "button button-primary" : "button button-quiet"}
        onClick={() => void stop()}
        disabled={!live || busy}
        data-testid="jam-director-stop"
      >
        {busy && live ? "Stopping…" : "Stop"}
      </button>
    </div>

    {/*
      * A refused Play is reported where Play is.
      *
      * This sat at the foot of the card, under the direction log and a
      * paragraph of notes, which is far enough from the button to read as
      * nothing happening at all — and the most common refusal, a server with
      * no director configured, is exactly the one a reader needs told.
      */}
    {failure && <Notice>{failure}</Notice>}
    {/*
      * What a press commits to, before it is pressed, and what it is costing
      * while it runs. The numbers are the server's own: the budget route
      * before a take, the session snapshot during one.
      */}
    <p className="form-note" data-testid="jam-director-cost">
      {costLine({ budget, spend, maxSeconds, live })}
    </p>

    {/*
      * There is no direction box here on purpose.
      *
      * How a room steers a take is the story outline's question — a beat edit
      * carries the change, the room's own mechanisms (vote, poll, chat) queue
      * it, and the server decides what reaches the provider. A free-text field
      * beside the player was a second, unqueued way in that bypassed all of
      * that. The log below still shows every direction that reaches the take,
      * whichever mechanism sent it.
      */}
    <DirectionLog entries={audit} />

    <p className="form-note">
      Anybody here can play the stream and anybody can stop it, and everybody
      sees the same film. Every direction goes through this server, which holds
      the stream and records it. The stream bills by the second with a
      one-minute minimum, so stop it when the room is done with this take.
      {durable ? "" : " This server has no recording storage configured, so the recording is lost when it restarts."}
    </p>

    {state.error && <Notice>{state.error}</Notice>}
  </div>;
}

/**
 * Which beats are closed and which can still change.
 *
 * The beat on screen and the one behind it are already with the provider, so
 * an edit there would arrive too late to matter. Saying so is the point: the
 * gap is the room's window to react to a change before it is rendered.
 */
function BeatWindow({
  beats,
  attached,
}: {
  beats: DirectorBeatWindow;
  attached: boolean;
}) {
  const playing = beats.currentBeatIndex;
  return <p className="form-note">
    {playing === null
      ? "Beat 1 is already being generated."
      : `Beat ${playing + 1} is playing${
          beats.lockedBeatIndex === null
            ? " and it is the last one"
            : `, beat ${beats.lockedBeatIndex + 1} is already being generated`
        }.`}
    {" "}Edits from beat {beats.minEditableBeatIndex + 1} onward still change the film.
    {attached ? " You joined a stream this room already had open." : ""}
  </p>;
}

/** What was asked for and what the model did with it. */
function DirectionLog({ entries }: { entries: DirectorAuditEntry[] }) {
  const directions = entries.filter((entry) => entry.kind === "direction_sent");
  if (directions.length === 0) return null;
  return <ol className="contribution-list" aria-label="Directions sent">
    {directions.map((entry) => {
      const applied = entries.some(
        (other) =>
          other.kind === "direction_applied" && other.promptVersion === entry.promptVersion,
      );
      const rejected = entries.some(
        (other) =>
          other.kind === "direction_rejected" && other.promptVersion === entry.promptVersion,
      );
      return <article className="contribution director" key={`${entry.promptVersion}-${entry.at}`}>
        <span>{applied ? "applied" : rejected ? "refused" : "pending"}</span>
        <p>{entry.body}</p>
      </article>;
    })}
  </ol>;
}

/**
 * What the room shows about itself.
 *
 * The lifecycle is the base — live, playing, ended — with the transitional
 * detail the stream reports laid over it, so "PLAYING" does not appear while
 * the provider is still warming up and the screen is still blank.
 */
function badge(
  state: DirectorState,
  busy: boolean,
  live: boolean,
  lifecycle: JamLifecycle,
): string {
  if (busy && !live) return "STARTING";
  if (state.status === "failed") return "FAILED";
  if (live && state.status !== "streaming") return "WARMING UP";
  return lifecycleLabel(lifecycle).toUpperCase();
}

function placeholder(
  state: DirectorState,
  live: boolean,
  lifecycle: JamLifecycle,
  joining: boolean,
): string {
  if (state.status === "failed") return "The stream stopped.";
  if (live) {
    return "The stream is running on the server and forwarded here as it is generated.";
  }
  // Arriving. Whether this room is playing is a question the server has been
  // asked and has not answered yet, and "nothing is streaming" is not the
  // answer to give while it is still open.
  if (joining) return "Looking for what this room is playing…";
  // A stopped room with nothing to show recorded nothing, which is worth
  // saying: the alternative reads as if the film were still loading.
  if (lifecycle === "ended") return "This take is over. Play to start the next one.";
  return "Nothing is streaming yet. Play to start it.";
}

/**
 * What is happening right now, in the order a reader asks it.
 *
 * Every branch here is a state somebody watching this screen can otherwise
 * only guess at: a press that has not been answered yet, a session that is
 * open but has sent no frames, a take that stopped because the server capped
 * it rather than because somebody pressed Stop.
 */
function statusLine(
  state: DirectorState,
  live: boolean,
  busy: boolean,
  lifecycle: JamLifecycle,
  joining: boolean,
): string {
  if (busy && !live) return "Opening the session with the provider…";
  if (joining && !live) {
    return "Joining this room: if it is already playing, its take opens here on its own.";
  }
  if (busy && live) return "Stopping the take and closing the provider session…";
  if (live && state.status === "streaming") {
    return `Playing · ${formatClock(state.generatedSeconds)} generated across ${state.chunksReceived} chunk(s) · direction ${state.appliedPromptVersion} is on screen.`;
  }
  if (live) {
    return "Connected to the provider. Nothing has arrived yet: the opening of the script is being generated.";
  }
  if (state.endedReason === "session_limit") {
    return "The take stopped on its own: it reached this server's session limit.";
  }
  if (state.status === "failed") {
    return "The take stopped because the provider stream failed.";
  }
  if (lifecycle === "ended") {
    return "This room is between takes. Its last one is below; Play starts the next.";
  }
  return "Nothing is playing. Anybody in the room can press Play.";
}

/**
 * What a take costs: committed before it starts, spent while it runs.
 *
 * The reservation is stated because it is the number that surprises — opening
 * a take commits the whole ceiling to the budget until it settles, so a room
 * with money left can still be refused a second take, and being told that
 * afterwards is being told too late.
 */
function costLine({
  budget,
  spend,
  maxSeconds,
  live,
}: {
  budget: DirectorBudget | null;
  spend: DirectorSpend | null;
  maxSeconds: number | null;
  live: boolean;
}): string {
  if (!spend) return "Reading what this server will spend…";
  if (spend.budgetUsd <= 0) {
    return "No director budget is configured on this server, so nothing can be generated here.";
  }
  const stopsItself =
    maxSeconds === null ? "" : ` It stops itself after ${formatClock(maxSeconds)}.`;
  if (live) {
    return `This take has cost ${formatUsd(spend.sessionUsd)} so far · ${formatUsd(spend.remainingUsd)} left of ${formatUsd(spend.budgetUsd)}.${stopsItself}`;
  }
  const minimum = formatUsd(spend.minBilledSeconds * spend.usdPerSecond);
  const reserved =
    maxSeconds === null ? null : formatUsd(maxSeconds * spend.usdPerSecond);
  const commitment = reserved
    ? ` Opening one holds ${reserved} of the budget until the take settles.`
    : "";
  const configured = budget && !budget.configured
    ? " This server has no live director configured, so Play will be refused."
    : "";
  return `Play opens a paid session: ${minimum} minimum for the first ${spend.minBilledSeconds}s.${stopsItself}${commitment} ${formatUsd(spend.remainingUsd)} left of ${formatUsd(spend.budgetUsd)}.${configured}`;
}

/**
 * The room's films, newest first.
 *
 * A take is listed whether or not it stored anything: the record exists from
 * the moment Play is pressed, and a take that recorded nothing is a fact about
 * the room worth showing rather than a row to hide. Opening one says which it
 * was.
 */
function FilmShelf({
  films,
  openId,
  onOpen,
}: {
  films: ArchivedFilm[];
  openId: string | null;
  onOpen: (film: ArchivedFilm) => void;
}) {
  return (
    <nav className="hero-actions" aria-label="Films this room has made">
      {films.map((film) => (
        <button
          key={film.id}
          className={film.id === openId ? "button button-primary" : "button button-quiet"}
          onClick={() => onOpen(film)}
          aria-current={film.id === openId ? "true" : undefined}
          data-testid={`jam-film-${film.id}`}
        >
          {taken(film.startedAt)}
          {/* A take whose process died mid-stream still plays, up to where it
              got to. Saying so beats presenting a partial film as whole. */}
          {film.complete ? "" : " · cut short"}
        </button>
      ))}
    </nav>
  );
}

/** When a take was made, in the reader's own time zone. */
function taken(startedAt: string): string {
  const at = new Date(startedAt);
  return Number.isNaN(at.getTime())
    ? "A take"
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Go to a minute of the film by picking the piece that contains it.
 *
 * The film is one HLS playlist, so this is a seek rather than a new request:
 * the player already knows which piece holds that second and fetches only
 * that one. Each piece begins on a keyframe, which is what makes the jump
 * land on a frame instead of on a stall.
 */
function PieceJump({
  pieces,
  onJump,
  onWhole,
}: {
  pieces: ArchivedPiece[];
  onJump: (startSeconds: number) => void;
  onWhole: () => void;
}) {
  return (
    <nav className="hero-actions" aria-label="Go to a moment in the film">
      <button className="button button-quiet" onClick={onWhole}>
        Whole film
      </button>
      {pieces.map((piece) => (
        <button
          key={piece.segmentIndex}
          className="button button-quiet"
          onClick={() => onJump(piece.startSeconds)}
          data-testid={`jam-piece-${piece.segmentIndex}`}
        >
          {clock(piece.startSeconds)}
        </button>
      ))}
    </nav>
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
