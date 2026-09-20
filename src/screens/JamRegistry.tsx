import { useEffect, useState } from "react";
import { Footer, Notice } from "../chrome";
import type { JamRoom } from "../core/room";
import { safeMessageOf } from "../lib/errors";
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
            <p className="eyebrow registry-kind">{STARTED_KIND_LABEL[kind]} · {jam.status.toUpperCase()} · {jam.visibility === "public" ? "PUBLIC" : "INVITE ONLY"}</p>
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
