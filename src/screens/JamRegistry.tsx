import { useEffect, useState } from "react";
import { Footer, Notice } from "../chrome";
import type { JamRoom } from "../core/room";
import { lifecycleLabel, type JamLifecycle } from "../core/jamLifecycle";
import { safeMessageOf } from "../lib/errors";
import { readJamLifecycle } from "../lib/directorSession";
import { listJams, type JamPersistence } from "../lib/jams";
import {
  DEFAULT_STARTED_KIND,
  readStartedKind,
  STARTED_KIND_LABEL,
  STARTED_KIND_MEANING,
  type StartedKind,
} from "../lib/startedKinds";
import { TopBar } from "../shell/TopBar";

type Props = {
  onNew: () => void;
  onOpen: (jam: JamRoom, persistence: JamPersistence) => void;
  /** Opens the jam as a Director session: one person, no room. */
  onDirect: (jam: JamRoom, persistence: JamPersistence) => void;
};

/** A room, and which of the three ways it was started. */
type Started = { jam: JamRoom; kind: StartedKind };

/**
 * Yours: everything you have started, whichever of the three it is.
 *
 * All three are rooms in the same table — that is what they have in common and why one list
 * holds them — but they are not the same experience, so each card says which it is rather than
 * leaving three different things looking alike. Where a Movie Jam can still be worked either
 * way (a room, or alone), it offers both; the other two open the one place they belong.
 *
 * Starting something is not here. That is the door at `/create`.
 */
export function JamRegistry({ onNew, onOpen, onDirect }: Props) {
  const [started, setStarted] = useState<readonly Started[]>([]);
  /**
   * Where each room actually is, as the server holds it.
   *
   * The `jams` row carries a `status` that nothing ever moved off `draft`, so
   * reading it told every reader the same wrong thing. A room's real state is
   * its lifecycle, and it lives with the server that runs the takes — one
   * small read per card, and a room this server has never heard of is `live`,
   * which is where a room that has not played yet genuinely is.
   */
  const [lifecycles, setLifecycles] = useState<Record<string, JamLifecycle>>({});
  const [persistence, setPersistence] = useState<JamPersistence>("preview");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listJams()
      .then((registry) => {
        if (!active) return;
        setStarted(registry.jams.map((jam) => ({ jam, kind: readStartedKind(jam.id) ?? DEFAULT_STARTED_KIND })));
        setPersistence(registry.persistence);
        setPhase("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setError(safeMessageOf(cause, "What you have started could not be loaded."));
        setPhase("error");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (started.length === 0) return;
    let active = true;
    void Promise.all(
      // Bounded: the list draws a handful of cards, and one unreadable room
      // must not cost the rest of them their state.
      started.slice(0, 24).map(async ({ jam }) => {
        const lifecycle = await readJamLifecycle(jam.id).catch<JamLifecycle>(() => "live");
        return [jam.id, lifecycle] as const;
      }),
    ).then((pairs) => {
      if (active) setLifecycles(Object.fromEntries(pairs));
    });
    return () => {
      active = false;
    };
  }, [started]);

  return <main className="site-shell registry-shell"><TopBar current="jam" />
    <section className="registry-layout">
      <header className="registry-head">
        <p className="eyebrow">YOURS</p>
        <h1>Everything you have <em>started.</em></h1>
        <p className="intro">Movie Jams, Director sessions and escape rooms, newest first. Open one to carry on with it.</p>
        <button className="button button-primary" onClick={onNew}>Make something new <span>↗</span></button>
      </header>

      <div className="registry-list" aria-live="polite">
        {phase === "loading" && <p className="registry-empty">Loading what you have started…</p>}
        {phase === "error" && <Notice>{error}</Notice>}
        {phase === "ready" && persistence === "preview" && <Notice tone="status">Supabase is not configured. These are browser-only preview registrations.</Notice>}
        {phase === "ready" && started.length === 0 && <div className="registry-empty"><h2>You have not started anything yet.</h2><p>A Movie Jam, a Director session or an escape room will appear here as soon as you make one.</p></div>}
        {started.map(({ jam, kind }) => <article className="registry-card" key={jam.id}>
          <div>
            <p className="eyebrow registry-kind" data-testid={`jam-state-${jam.id}`}>{STARTED_KIND_LABEL[kind]} · {lifecycleLabel(lifecycles[jam.id] ?? "live").toUpperCase()} · {jam.visibility === "public" ? "PUBLIC" : "INVITE ONLY"}</p>
            <h2>{jam.title}</h2>
            <p className="registry-meaning">{STARTED_KIND_MEANING[kind]}</p>
            <p>{jam.premise}</p>
          </div>
          <div className="registry-ways">
            {kind === "jam" ? <>
              <button className="button button-quiet" onClick={() => onOpen(jam, persistence)}>With people <span>→</span></button>
              <button className="button button-quiet" onClick={() => onDirect(jam, persistence)}>Alone <span>→</span></button>
            </> : <button className="button button-quiet" onClick={() => (kind === "director" ? onDirect(jam, persistence) : onOpen(jam, persistence))}>Open <span>→</span></button>}
          </div>
        </article>)}
      </div>
    </section><Footer />
  </main>;
}
