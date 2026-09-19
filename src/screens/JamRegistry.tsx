import { useEffect, useState } from "react";
import { Footer, Notice } from "../chrome";
import type { JamRoom } from "../core/room";
import { safeMessageOf } from "../lib/errors";
import { listJams, type JamPersistence } from "../lib/jams";
import { TopBar } from "../shell/TopBar";

type Props = {
  onNew: () => void;
  onOpen: (jam: JamRoom, persistence: JamPersistence) => void;
};

export function JamRegistry({ onNew, onOpen }: Props) {
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
        <p className="intro">Open a jam already in progress, or register a new room with its own script.</p>
        <button className="button button-primary" onClick={onNew}>Start a new jam <span>↗</span></button>
      </header>

      <div className="registry-list" aria-live="polite">
        {phase === "loading" && <p className="registry-empty">Loading your jams…</p>}
        {phase === "error" && <Notice>{error}</Notice>}
        {phase === "ready" && persistence === "preview" && <Notice tone="status">Supabase is not configured. These are browser-only preview registrations.</Notice>}
        {phase === "ready" && jams.length === 0 && <div className="registry-empty"><h2>No running jams yet.</h2><p>Your next room will appear here as soon as it is registered.</p></div>}
        {jams.map((jam) => <article className="registry-card" key={jam.id}>
          <div><p className="eyebrow">{jam.status.toUpperCase()} · {jam.visibility === "public" ? "PUBLIC" : "INVITE ONLY"}</p><h2>{jam.title}</h2><p>{jam.premise}</p></div>
          <button className="button button-quiet" onClick={() => onOpen(jam, persistence)}>Open jam <span>→</span></button>
        </article>)}
      </div>
    </section><Footer />
  </main>;
}
