import { useEffect, useState } from "react";
import { Footer, Notice } from "../chrome";
import type { JamRoom } from "../core/room";
import { safeMessageOf } from "../lib/errors";
import { listJams, type JamPersistence } from "../lib/jams";
import { TopBar } from "../shell/TopBar";

type Props = {
  onNew: () => void;
  onOpen: (jam: JamRoom, persistence: JamPersistence) => void;
  /** Opens the jam as a Director session: one person, no room. */
  onDirect: (jam: JamRoom, persistence: JamPersistence) => void;
};

/**
 * Your rooms, and the two ways to work on one.
 *
 * A jam can be made with people — the Studio, where a room chats, proposes and
 * watches together — or alone, as a Director session at `/director/:slug`,
 * where one person talks the film into being. Both are the same jam and the
 * same script; they differ in who is in the room. The choice belongs here
 * rather than in the top bar, which already carries five destinations that
 * have to fit a 360-pixel screen.
 */
export function JamRegistry({ onNew, onOpen, onDirect }: Props) {
  const [jams, setJams] = useState<JamRoom[]>([]);
  const [persistence, setPersistence] = useState<JamPersistence>("preview");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listJams()
      .then((registry) => {
        if (!active) return;
        setJams(registry.jams.filter((jam) => jam.status !== "completed" && jam.status !== "closed"));
        setPersistence(registry.persistence);
        setPhase("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setError(safeMessageOf(cause, "Your jams could not be loaded."));
        setPhase("error");
      });
    return () => { active = false; };
  }, []);

  return <main className="site-shell registry-shell"><TopBar current="jam" />
    <section className="registry-layout">
      <header className="registry-head">
        <p className="eyebrow">MOVIE JAMS</p>
        <h1>Your stories, <em>still running.</em></h1>
        <p className="intro">Open a jam already in progress, or register a new room with its own script. Work on one with people, or alone.</p>
        <button className="button button-primary" onClick={onNew}>Start a new jam <span>↗</span></button>
      </header>

      <div className="registry-list" aria-live="polite">
        {phase === "loading" && <p className="registry-empty">Loading your jams…</p>}
        {phase === "error" && <Notice>{error}</Notice>}
        {phase === "ready" && persistence === "preview" && <Notice tone="status">Supabase is not configured. These are browser-only preview registrations.</Notice>}
        {phase === "ready" && jams.length === 0 && <div className="registry-empty"><h2>No running jams yet.</h2><p>Your next room will appear here as soon as it is registered.</p></div>}
        {jams.map((jam) => <article className="registry-card" key={jam.id}>
          <div><p className="eyebrow">{jam.status.toUpperCase()} · {jam.visibility === "public" ? "PUBLIC" : "INVITE ONLY"}</p><h2>{jam.title}</h2><p>{jam.premise}</p></div>
          <div className="registry-ways">
            <button className="button button-quiet" onClick={() => onOpen(jam, persistence)}>With people <span>→</span></button>
            <button className="button button-quiet" onClick={() => onDirect(jam, persistence)}>Alone <span>→</span></button>
          </div>
        </article>)}
      </div>
    </section><Footer />
  </main>;
}
