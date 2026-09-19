import { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Footer, Header } from "./chrome";
import type { Jam as GeneratedJam, JamSource } from "./core/jam";
import { createJam as createJamRoom, getJam as getJamRoom, type Jam as JamRoom, type JamPersistence, type JamVisibility } from "./lib/jams";
import { hasSupabaseConfiguration } from "./lib/supabase";
import { ScriptScreen } from "./ScriptScreen";
import "./styles.css";

type Screen = "home" | "create" | "join" | "script" | "studio";
type SourceKind = "from-scratch" | "from-movie";
type Contribution = { author: string; text: string; kind: "host" | "director" };

const starterContributions: Contribution[] = [
  { author: "Reverie", text: "Set a premise, invite the room, then collect the first turn.", kind: "director" },
  { author: "You", text: "The story begins with a signal arriving from beyond the screen.", kind: "host" },
];

function screenFromPath(pathname: string): Screen {
  if (pathname === "/jams/new") return "create";
  if (pathname === "/join") return "join";
  if (pathname.startsWith("/jams/")) return "studio";
  return "home";
}

function jamSlugFromPath(pathname: string) {
  const match = pathname.match(/^\/jams\/([a-z0-9-]+)$/);
  return match?.[1] ?? null;
}

function App() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname));
  const [roomTitle, setRoomTitle] = useState("Untitled Movie Jam");
  const [premise, setPremise] = useState("A signal changes what the room thinks is possible.");
  const [visibility, setVisibility] = useState<JamVisibility>("invite_only");
  const [persistence, setPersistence] = useState<JamPersistence>(hasSupabaseConfiguration() ? "remote" : "preview");
  const [sourceKind, setSourceKind] = useState<SourceKind>("from-scratch");
  const [movieTitle, setMovieTitle] = useState("");
  const [movieSummary, setMovieSummary] = useState("");
  const [generatedJam, setGeneratedJam] = useState<GeneratedJam | null>(null);
  const [contributions, setContributions] = useState(starterContributions);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  function navigate(next: Screen, path: string) {
    window.history.pushState({}, "", path);
    setScreen(next);
    setNotice(null);
  }

  useEffect(() => {
    const handlePopState = () => setScreen(screenFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const slug = jamSlugFromPath(window.location.pathname);
    if (screen !== "studio" || !slug || slug.startsWith("preview-")) return;

    let active = true;
    void getJamRoom(slug)
      .then((jam) => {
        if (!active || !jam) return;
        applyJam(jam, "remote");
      })
      .catch((error: unknown) => {
        if (active) setNotice(error instanceof Error ? error.message : "The Jam room could not be loaded.");
      });
    return () => { active = false; };
  }, [screen]);

  function applyJam(jam: JamRoom, mode: JamPersistence) {
    setRoomTitle(jam.title);
    setPremise(jam.premise);
    setVisibility(jam.visibility);
    setPersistence(mode);
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;
    const source: JamSource = sourceKind === "from-scratch"
      ? { kind: "from-scratch", prompt: premise.trim() }
      : {
          kind: "from-movie",
          movieTitle: movieTitle.trim(),
          ...(movieSummary.trim() ? { movieSummary: movieSummary.trim() } : {}),
        };
    const roomPremise = sourceKind === "from-scratch" ? premise.trim() : `An original story inspired by “${movieTitle.trim()}”.`;
    setIsCreating(true);
    setNotice(null);
    try {
      const response = await fetch("/api/jams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(body?.error?.safeMessage ?? "The jam script could not be created.");
        return;
      }
      const script = body.jam as GeneratedJam;
      setGeneratedJam(script);
      let scriptPath = "/jams/new";
      let roomNote = "";
      try {
        const created = await createJamRoom({ title: roomTitle, premise: roomPremise.slice(0, 280), visibility });
        applyJam(created.jam, created.persistence);
        scriptPath = `/jams/${created.jam.slug}`;
        roomNote = created.persistence === "remote" ? "Your persistent room is ready." : "Supabase is not configured, so the room is a local preview only.";
      } catch (error) {
        roomNote = error instanceof Error ? error.message : "The Jam room could not be persisted; the script is still yours.";
      }
      setContributions([
        { author: "Reverie", text: `Script ready: “${script.script.title}” — ${script.script.logline} ${roomNote}`.trim(), kind: "director" },
        { author: "You", text: roomPremise, kind: "host" },
      ]);
      navigate("script", scriptPath);
    } catch {
      setNotice("The server could not be reached.");
    } finally {
      setIsCreating(false);
    }
  }

  function addContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setContributions((items) => [...items, { author: "You", text, kind: "host" }]);
    setDraft("");
  }

  if (screen === "create") {
    return <CreateRoom title={roomTitle} premise={premise} visibility={visibility} sourceKind={sourceKind} movieTitle={movieTitle} movieSummary={movieSummary} onTitle={setRoomTitle} onPremise={setPremise} onVisibility={setVisibility} onSourceKind={setSourceKind} onMovieTitle={setMovieTitle} onMovieSummary={setMovieSummary} onBack={() => navigate("home", "/")} onSubmit={createRoom} isCreating={isCreating} notice={notice} />;
  }
  if (screen === "script" && generatedJam) {
    return <ScriptScreen jam={generatedJam} roomTitle={roomTitle} onStudio={() => setScreen("studio")} onBack={() => navigate("create", "/jams/new")} />;
  }
  if (screen === "join") return <JoinRoom onBack={() => navigate("home", "/")} notice={notice} onJoin={() => setNotice("Invite lookup arrives with the Supabase membership and lobby milestone.")} />;
  if (screen === "studio") return <Studio title={roomTitle} visibility={visibility} persistence={persistence} contributions={contributions} draft={draft} onDraft={setDraft} onSubmit={addContribution} onExit={() => navigate("home", "/")} />;
  return <Home onCreate={() => navigate("create", "/jams/new")} onJoin={() => navigate("join", "/join")} />;
}

function Home({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return <main className="site-shell"><Header onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
    <section className="hero" id="jam"><div className="hero-copy"><p className="eyebrow">A LIVE COLLABORATIVE FILM STUDIO</p><h1>Make the next scene <em>together.</em></h1><p className="intro">Start a room, invite the people around you, and direct a new story one clear turn at a time.</p><div className="hero-actions"><button className="button button-primary" onClick={onCreate}>Start a Movie Jam <span>↗</span></button><button className="button button-quiet" onClick={onJoin}>Join with an invite <span>→</span></button></div></div><LiveScene /></section>
    <section className="steps" aria-label="How Movie Jam works"><article><span>01</span><h2>Invite the room</h2><p>Share a QR code or link. Everyone enters with a name and a point of view.</p></article><article><span>02</span><h2>Direct the turn</h2><p>Speak, write, show an image, upload a clip, or share a live reference.</p></article><article><span>03</span><h2>See it evolve</h2><p>The selected direction becomes an editable scene, screenplay, and visual world.</p></article></section><Footer />
  </main>;
}

type CreateRoomProps = {
  title: string; premise: string; visibility: JamVisibility;
  sourceKind: SourceKind; movieTitle: string; movieSummary: string;
  onTitle: (value: string) => void; onPremise: (value: string) => void; onVisibility: (value: JamVisibility) => void;
  onSourceKind: (value: SourceKind) => void; onMovieTitle: (value: string) => void; onMovieSummary: (value: string) => void;
  onBack: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; isCreating: boolean; notice: string | null;
};

function CreateRoom({ title, premise, visibility, sourceKind, movieTitle, movieSummary, onTitle, onPremise, onVisibility, onSourceKind, onMovieTitle, onMovieSummary, onBack, onSubmit, isCreating, notice }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><Header onHome={onBack} /><section className="setup-layout">
    <div className="setup-intro"><button className="back-link" onClick={onBack}>← Back to Reverie</button><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">Start from scratch with a small prompt, or riff on a movie you love. Reverie writes a 4-minute script in 10–20 second scene portions for the room to direct.</p></div>
    <form className="room-form" onSubmit={onSubmit}>
      <label>Jam title<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button type="button" role="radio" aria-checked={sourceKind === "from-movie"} className={sourceKind === "from-movie" ? "active" : ""} onClick={() => onSourceKind("from-movie")}>From an existing movie</button>
      </div>
      {sourceKind === "from-scratch" ? (
        <label>Opening premise<textarea value={premise} onChange={(event) => onPremise(event.target.value)} minLength={8} maxLength={280} required /></label>
      ) : (
        <>
          <label>Movie title<input value={movieTitle} onChange={(event) => onMovieTitle(event.target.value)} maxLength={120} placeholder="The film your room wants to riff on" required /></label>
          <label>What the room remembers about it (optional)<textarea value={movieSummary} onChange={(event) => onMovieSummary(event.target.value)} maxLength={1000} /></label>
        </>
      )}
      <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only</option><option value="public">Public room</option></select></label>
      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} The script is an original generated work — never a copy of an existing film.</p>
      <button className="button button-primary form-submit" type="submit" disabled={isCreating}>{isCreating ? "Writing your 4-minute script…" : "Write the script"}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
  </section><Footer />
  </main>;
}

function JoinRoom({ onBack, onJoin, notice }: { onBack: () => void; onJoin: () => void; notice: string | null }) {
  return <main className="site-shell setup-shell"><Header onHome={onBack} /><section className="join-layout"><div className="join-card"><button className="back-link" onClick={onBack}>← Back to Reverie</button><p className="eyebrow">JOIN A MOVIE JAM</p><h1>Take a seat in the <em>room.</em></h1><p className="intro">Enter the invite link or room code shared by the host.</p><label>Invite link or room code<input placeholder="reverie.tv/jam/…" /></label><label>Your display name<input placeholder="Your name" /></label><button className="button button-primary form-submit" onClick={onJoin}>Join the room <span>→</span></button>{notice && <aside className="notice" role="status"><span className="notice-dot" />{notice}<button onClick={onBack} aria-label="Dismiss message">×</button></aside>}</div></section><Footer /></main>;
}

function Studio({ title, visibility, persistence, contributions, draft, onDraft, onSubmit, onExit }: { title: string; visibility: JamVisibility; persistence: JamPersistence; contributions: Contribution[]; draft: string; onDraft: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onExit: () => void }) {
  const modeLabel = persistence === "remote" ? "PERSISTENT ROOM" : "LOCAL PREVIEW";
  return <main className="site-shell studio-shell"><Header onHome={onExit} /><section className="studio-header"><div><p className="eyebrow">MOVIE JAM / {modeLabel}</p><h1>{title}</h1><p>{visibility === "public" ? "Public room" : "Invite-only room"} · Scene 01 is waiting for the room.</p></div><div className="studio-actions"><button className="button button-quiet" onClick={onExit}>Exit preview</button><button className="button button-primary" onClick={() => window.alert(persistence === "remote" ? "Share this room URL from the browser address bar. QR and lobby controls are next." : "Configure Supabase before sharing this room. Local previews do not persist.")}>Invite guests <span>↗</span></button></div></section><section className="studio-grid"><aside className="conversation-panel"><div className="panel-heading"><div><p className="eyebrow">STORY CONVERSATION</p><h2>What should happen next?</h2></div><span className="local-badge">{persistence === "remote" ? "ROOM READY" : "LOCAL"}</span></div><div className="contribution-list" aria-live="polite">{contributions.map((item, index) => <article className={`contribution ${item.kind}`} key={`${item.author}-${index}`}><span>{item.author}</span><p>{item.text}</p></article>)}</div><form className="contribution-form" onSubmit={onSubmit}><label className="sr-only" htmlFor="direction">Propose a story direction</label><textarea id="direction" value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Add a character, twist, shot, or feeling…" maxLength={280} /><button className="button button-primary" type="submit">Propose <span>↗</span></button></form></aside><div className="studio-scene"><LiveScene compact /><div className="queue-card"><div><p className="eyebrow">UP NEXT</p><h2>Proposals join the queue.</h2></div><p>Realtime proposals, membership, voting, and scene transitions are the next room milestone.</p></div></div></section><Footer />
  </main>;
}

function LiveScene({ compact = false }: { compact?: boolean }) {
  return <div className={`scene-card ${compact ? "scene-card-compact" : ""}`} aria-label="Illustration of a live film jam"><div className="scene-meta"><span><i /> LIVE DIRECTION</span><span>SCENE 01 / 06</span></div><div className="moon" /><div className="mountains mountain-back" /><div className="mountains mountain-front" /><div className="character character-left"><span /></div><div className="character character-center"><span /></div><div className="character character-right"><span /></div><div className="scene-caption"><p>NOW DIRECTING</p><h2>Three friends follow a signal through the stars.</h2></div></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
