import { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Footer, Header, LiveScene, Notice } from "./chrome";
import type { Jam as GeneratedJam, JamSource } from "./core/jam";
import { safeMessageOf } from "./lib/errors";
import { createJam as createJamRoom, type JamPersistence, type JamRoom, type JamVisibility } from "./lib/jams";
import { hasSupabaseConfiguration } from "./lib/supabase";
import { DiscoverScreen } from "./discover/DiscoverScreen";
import { ScriptScreen } from "./ScriptScreen";
import { JoinRoom } from "./screens/JoinRoom";
import { Studio } from "./screens/Studio";
import { JamRegistry } from "./screens/JamRegistry";
import { DISCOVER_PATH, filmFromPath, filmPath, jamSlugFromPath, screenFromPath, type Screen } from "./lib/routes";
import "./styles.css";

type SourceKind = "from-scratch" | "import-script";

/** Marks a history entry pushed by opening a film from the grid, so closing it can go back. */
const FILM_FROM_GRID = "reverie:film-from-grid";

function inviteCodeFromLocation() {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

function App() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname));
  const [slug, setSlug] = useState<string | null>(() => jamSlugFromPath(window.location.pathname));
  const [film, setFilm] = useState(() => filmFromPath(window.location.pathname));
  const [inviteCode, setInviteCode] = useState(() => inviteCodeFromLocation());
  const [roomTitle, setRoomTitle] = useState("Untitled Movie Jam");
  const [premise, setPremise] = useState("A signal changes what the room thinks is possible.");
  const [visibility, setVisibility] = useState<JamVisibility>("invite_only");
  const [persistence, setPersistence] = useState<JamPersistence>(hasSupabaseConfiguration() ? "remote" : "preview");
  const [sourceKind, setSourceKind] = useState<SourceKind>("from-scratch");
  const [importedScript, setImportedScript] = useState("");
  const [totalMinutes, setTotalMinutes] = useState(4);
  const [portionMinSeconds, setPortionMinSeconds] = useState(10);
  const [portionMaxSeconds, setPortionMaxSeconds] = useState(20);
  const [generatedJam, setGeneratedJam] = useState<GeneratedJam | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [registeredRoom, setRegisteredRoom] = useState<JamRoom | null>(null);

  function navigate(next: Screen, path: string, { replace = false, state = {} }: { replace?: boolean; state?: object } = {}) {
    if (replace) window.history.replaceState(state, "", path);
    else window.history.pushState(state, "", path);
    setScreen(next);
    setSlug(jamSlugFromPath(path));
    setFilm(filmFromPath(path));
    setInviteCode(inviteCodeFromLocation());
    setNotice(null);
  }

  useEffect(() => {
    const handlePopState = () => {
      setScreen(screenFromPath(window.location.pathname));
      setSlug(jamSlugFromPath(window.location.pathname));
      setFilm(filmFromPath(window.location.pathname));
      setInviteCode(inviteCodeFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
      : { kind: "imported-script", scriptTitle: roomTitle.trim() };
    const roomPremise = sourceKind === "from-scratch" ? premise.trim() : "A Movie Jam created from an imported script.";
    setIsCreating(true);
    setNotice(null);
    try {
      const created = registeredRoom
        ? { jam: registeredRoom, persistence }
        : await createJamRoom({ id: crypto.randomUUID(), title: roomTitle.trim(), premise: roomPremise.slice(0, 280), visibility });
      setRegisteredRoom(created.jam);
      applyJam(created.jam, created.persistence);
      const response = await fetch("/api/jams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: sourceKind === "from-scratch" ? "generate" : "import",
          source,
          ...(sourceKind === "import-script" ? { scriptMarkdown: importedScript.trim() } : {}),
          jamId: created.jam.id,
          format: {
            totalSeconds: Math.round(totalMinutes * 60),
            portionMinSeconds,
            portionMaxSeconds,
          },
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice(`Jam registered, but its script is not ready: ${body?.error?.safeMessage ?? "the script could not be created."}`);
        return;
      }
      const script = body.jam as GeneratedJam;
      setGeneratedJam(script);
      navigate("script", `/jams/${created.jam.slug}`);
      if (created.persistence === "preview") setNotice("Supabase is not configured, so the jam is registered in this browser as a local preview only.");
    } catch (error) {
      setNotice(safeMessageOf(error, "The jam could not be registered."));
    } finally {
      setIsCreating(false);
    }
  }

  if (screen === "discover") {
    return <DiscoverScreen
      film={film}
      onOpenFilm={(providerId) => navigate("discover", filmPath(providerId), { state: { [FILM_FROM_GRID]: true } })}
      onCloseFilm={() => {
        // Opened from the grid: step back, so browser Back and this close stay one history.
        // Reached by URL: there is no grid entry behind it, so the grid replaces the page.
        if (window.history.state?.[FILM_FROM_GRID]) window.history.back();
        else navigate("discover", DISCOVER_PATH, { replace: true });
      }}
      onExit={() => navigate("home", "/")}
    />;
  }
  if (screen === "jams") return <JamRegistry onBack={() => navigate("home", "/")} onNew={() => { setRegisteredRoom(null); setGeneratedJam(null); navigate("create", "/jams/new"); }} onOpen={(jam, mode) => { applyJam(jam, mode); navigate("studio", `/jams/${jam.slug}`); }} />;
  if (screen === "create") {
    return <CreateRoom title={roomTitle} premise={premise} visibility={visibility} sourceKind={sourceKind} importedScript={importedScript} totalMinutes={totalMinutes} portionMinSeconds={portionMinSeconds} portionMaxSeconds={portionMaxSeconds} onTitle={setRoomTitle} onPremise={setPremise} onVisibility={setVisibility} onSourceKind={setSourceKind} onImportedScript={setImportedScript} onTotalMinutes={setTotalMinutes} onPortionMinSeconds={setPortionMinSeconds} onPortionMaxSeconds={setPortionMaxSeconds} onBack={() => navigate("jams", "/jams")} onSubmit={createRoom} isCreating={isCreating} notice={notice} />;
  }
  if (screen === "script" && generatedJam) {
    return <ScriptScreen jam={generatedJam} roomTitle={roomTitle} onStudio={() => setScreen("studio")} onBack={() => navigate("create", "/jams/new")} />;
  }
  if (screen === "join") {
    return <JoinRoom initialCode={inviteCode} onBack={() => navigate("home", "/")} onAdmitted={(result) => navigate("studio", `/jams/${result.slug}`)} />;
  }
  if (screen === "studio") {
    // A build without Supabase can only show the clearly labelled local preview. A
    // configured build that fails reports the failure inside Studio instead.
    return slug && hasSupabaseConfiguration() && !slug.startsWith("preview-")
      ? <Studio slug={slug} onExit={() => navigate("home", "/")} />
      : <PreviewStudio slug={slug ?? roomTitle} persistence={persistence} onExit={() => navigate("home", "/")} />;
  }
  return <Home onCreate={() => navigate("jams", "/jams")} onJoin={() => navigate("join", "/join")} />;
}

function Home({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return <main className="site-shell"><Header onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
    <section className="hero" id="jam"><div className="hero-copy"><p className="eyebrow">A LIVE COLLABORATIVE FILM STUDIO</p><h1>Make the next scene <em>together.</em></h1><p className="intro">Start a room, invite the people around you, and direct a new story one clear turn at a time.</p><div className="hero-actions"><button className="button button-primary" onClick={onCreate}>Start a Movie Jam <span>↗</span></button><button className="button button-quiet" onClick={onJoin}>Join with an invite <span>→</span></button><a className="button button-quiet" href="/discover">Find something to watch <span>→</span></a></div></div><LiveScene /></section>
    <section className="steps" aria-label="How Movie Jam works"><article><span>01</span><h2>Invite the room</h2><p>Share a QR code or link. Everyone enters with a name and a point of view.</p></article><article><span>02</span><h2>Direct the turn</h2><p>Speak, write, show an image, upload a clip, or share a live reference.</p></article><article><span>03</span><h2>See it evolve</h2><p>The selected direction becomes an editable scene, screenplay, and visual world.</p></article></section><Footer />
  </main>;
}

type CreateRoomProps = {
  title: string; premise: string; visibility: JamVisibility;
  sourceKind: SourceKind; importedScript: string;
  totalMinutes: number; portionMinSeconds: number; portionMaxSeconds: number;
  onTitle: (value: string) => void; onPremise: (value: string) => void; onVisibility: (value: JamVisibility) => void;
  onSourceKind: (value: SourceKind) => void; onImportedScript: (value: string) => void;
  onTotalMinutes: (value: number) => void; onPortionMinSeconds: (value: number) => void; onPortionMaxSeconds: (value: number) => void;
  onBack: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; isCreating: boolean; notice: string | null;
};

function CreateRoom({ title, premise, visibility, sourceKind, importedScript, totalMinutes, portionMinSeconds, portionMaxSeconds, onTitle, onPremise, onVisibility, onSourceKind, onImportedScript, onTotalMinutes, onPortionMinSeconds, onPortionMaxSeconds, onBack, onSubmit, isCreating, notice }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><Header onHome={onBack} /><section className="setup-layout">
    <div className="setup-intro"><button className="back-link" onClick={onBack}>← Back to your jams</button><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">Start from a prompt and let Reverie write, or bring an existing script into its own room.</p></div>
    <form className="room-form" onSubmit={onSubmit}>
      <label>Jam title<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
      <div className="jam-kind" role="radiogroup" aria-label="Story source">
        <button type="button" role="radio" aria-checked={sourceKind === "from-scratch"} className={sourceKind === "from-scratch" ? "active" : ""} onClick={() => onSourceKind("from-scratch")}>From scratch</button>
        <button type="button" role="radio" aria-checked={sourceKind === "import-script"} className={sourceKind === "import-script" ? "active" : ""} onClick={() => onSourceKind("import-script")}>Import a script</button>
      </div>
      {sourceKind === "from-scratch" ? (
        <label>Opening premise<textarea value={premise} onChange={(event) => onPremise(event.target.value)} minLength={8} maxLength={280} required /></label>
      ) : (
        <>
          <label>Existing script<textarea value={importedScript} onChange={(event) => onImportedScript(event.target.value)} minLength={40} maxLength={9000} placeholder="Paste the script this jam should use…" required /></label>
        </>
      )}
      <div className="format-row" role="group" aria-label="Script length">
        <label>Total length (min)<input type="number" min={0.2} max={15} step={0.1} value={totalMinutes} onChange={(event) => onTotalMinutes(Number(event.target.value))} required /></label>
        <label>Shortest portion (s)<input type="number" min={4} max={60} value={portionMinSeconds} onChange={(event) => onPortionMinSeconds(Number(event.target.value))} required /></label>
        <label>Longest portion (s)<input type="number" min={4} max={60} value={portionMaxSeconds} onChange={(event) => onPortionMaxSeconds(Number(event.target.value))} required /></label>
      </div>
      <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only</option><option value="public">Public room</option></select></label>
      <p className="form-note">{hasSupabaseConfiguration() ? "This room will receive its own persistent URL." : "Supabase is not configured yet, so this creates a clearly labelled local preview."} The script is an original generated work — never a copy of an existing film.</p>
      <button className="button button-primary form-submit" type="submit" disabled={isCreating}>{isCreating ? `Writing your ${totalMinutes}-minute script…` : "Write the script"}<span>↗</span></button>
      {notice && <aside className="notice" role="alert"><span className="notice-dot" />{notice}</aside>}
    </form>
  </section><Footer />
  </main>;
}

/** Shown only when Supabase is absent. It never claims to be a shared room. */
function PreviewStudio({ slug, persistence, onExit }: { slug: string; persistence: JamPersistence; onExit: () => void }) {
  return <main className="site-shell studio-shell"><Header onHome={onExit} />
    <section className="studio-header"><div><p className="eyebrow">MOVIE JAM / LOCAL PREVIEW</p><h1>{slug}</h1><p>This preview is not a room. Nothing here is shared, stored, or visible to anyone else.</p></div><div className="studio-actions"><button className="button button-quiet" onClick={onExit}>Back to Reverie</button></div></section>
    <Notice tone="status">{persistence === "remote" ? "This jam has no shareable room URL yet. Create the room again to get one." : <>Configure <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and apply the migrations in <code>supabase/migrations</code> to open a real room.</>}</Notice>
    <Footer />
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
