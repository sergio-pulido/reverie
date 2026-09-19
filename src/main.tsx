import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { AdmissionResult, JamVisibility } from "./core/jam";
import { safeMessageOf } from "./lib/errors";
import { createJam } from "./lib/jams";
import { hasSupabaseConfiguration } from "./lib/supabase";
import { Footer, Header, LiveScene, Notice } from "./screens/chrome";
import { JoinRoom } from "./screens/JoinRoom";
import { Studio } from "./screens/Studio";

type Screen = "home" | "create" | "join" | "studio";

function screenFromPath(pathname: string): Screen {
  if (pathname === "/jams/new") return "create";
  if (pathname === "/join") return "join";
  if (pathname.startsWith("/jams/")) return "studio";
  return "home";
}

function jamSlugFromPath(pathname: string) {
  return pathname.match(/^\/jams\/([a-z0-9-]+)$/)?.[1] ?? null;
}

function inviteCodeFromLocation() {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

function App() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname));
  const [slug, setSlug] = useState<string | null>(() => jamSlugFromPath(window.location.pathname));
  const [inviteCode, setInviteCode] = useState(() => inviteCodeFromLocation());

  useEffect(() => {
    function sync() {
      setScreen(screenFromPath(window.location.pathname));
      setSlug(jamSlugFromPath(window.location.pathname));
      setInviteCode(inviteCodeFromLocation());
    }
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function navigate(next: Screen, path: string) {
    window.history.pushState({}, "", path);
    setScreen(next);
    setSlug(jamSlugFromPath(path));
    setInviteCode(inviteCodeFromLocation());
  }

  function openJam(result: AdmissionResult) {
    navigate("studio", `/jams/${result.slug}`);
  }

  if (screen === "create") return <CreateRoom onBack={() => navigate("home", "/")} onCreated={(created) => navigate("studio", `/jams/${created}`)} />;
  if (screen === "join") return <JoinRoom initialCode={inviteCode} onBack={() => navigate("home", "/")} onAdmitted={openJam} />;
  if (screen === "studio" && slug) {
    // A build without Supabase can only show the clearly labelled local preview. A
    // configured build that fails reports the failure inside Studio instead.
    return hasSupabaseConfiguration() && !slug.startsWith("preview-")
      ? <Studio slug={slug} onExit={() => navigate("home", "/")} />
      : <PreviewStudio slug={slug} onExit={() => navigate("home", "/")} />;
  }
  return <Home onCreate={() => navigate("create", "/jams/new")} onJoin={() => navigate("join", "/join")} />;
}

function Home({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return <main className="site-shell"><Header onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
    <section className="hero" id="jam"><div className="hero-copy"><p className="eyebrow">A LIVE COLLABORATIVE FILM STUDIO</p><h1>Make the next scene <em>together.</em></h1><p className="intro">Start a room, invite the people around you, and direct a new story one clear turn at a time.</p><div className="hero-actions"><button className="button button-primary" onClick={onCreate}>Start a Movie Jam <span>↗</span></button><button className="button button-quiet" onClick={onJoin}>Join with an invite <span>→</span></button></div></div><LiveScene /></section>
    <section className="steps" aria-label="How Movie Jam works"><article><span>01</span><h2>Invite the room</h2><p>Share the invite code. Everyone enters with a name and a point of view.</p></article><article><span>02</span><h2>Direct the turn</h2><p>Write a line or queue a proposal. Everything appears in every connected browser.</p></article><article><span>03</span><h2>See it evolve</h2><p>The selected direction becomes an editable scene, screenplay, and visual world.</p></article></section><Footer />
  </main>;
}

function CreateRoom({ onBack, onCreated }: { onBack: () => void; onCreated: (slug: string) => void }) {
  const [title, setTitle] = useState("Untitled Movie Jam");
  const [premise, setPremise] = useState("A signal changes what the room thinks is possible.");
  const [visibility, setVisibility] = useState<JamVisibility>("invite_only");
  const [isCreating, setIsCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreating(true);
    setNotice(null);
    try {
      const created = await createJam({ title, premise, visibility });
      onCreated(created.jam.slug);
    } catch (error) {
      setNotice(safeMessageOf(error, "The Jam room could not be created."));
    } finally {
      setIsCreating(false);
    }
  }

  return <main className="site-shell setup-shell"><Header onHome={onBack} /><section className="setup-layout"><div className="setup-intro"><button className="back-link" onClick={onBack}>← Back to Reverie</button><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">This is the host's opening direction. Guests shape what happens next once the room opens.</p></div><form className="room-form" onSubmit={submit}><label>Jam title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={72} required /></label><label>Opening premise<textarea value={premise} onChange={(event) => setPremise(event.target.value)} maxLength={280} required /></label><label>Who can join?<select value={visibility} onChange={(event) => setVisibility(event.target.value as JamVisibility)}><option value="invite_only">Invite only — the host admits each guest</option><option value="public">Public — anyone with the code joins immediately</option></select></label><p className="form-note">{hasSupabaseConfiguration() ? "This room receives a persistent URL and its own invite code." : "Supabase is not configured yet, so this creates a clearly labelled local preview."}</p><button className="button button-primary form-submit" type="submit" disabled={isCreating}>{isCreating ? "Creating…" : "Create the room"}<span>↗</span></button>{notice && <Notice>{notice}</Notice>}</form></section><Footer /></main>;
}

/** Shown only when Supabase is absent. It never claims to be a shared room. */
function PreviewStudio({ slug, onExit }: { slug: string; onExit: () => void }) {
  return <main className="site-shell studio-shell"><Header onHome={onExit} />
    <section className="studio-header"><div><p className="eyebrow">MOVIE JAM / LOCAL PREVIEW</p><h1>{slug}</h1><p>This preview is not a room. Nothing here is shared, stored, or visible to anyone else.</p></div><div className="studio-actions"><button className="button button-quiet" onClick={onExit}>Back to Reverie</button></div></section>
    <Notice tone="status">Configure <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and apply the migrations in <code>supabase/migrations</code> to open a real room.</Notice>
    <section className="studio-grid"><div className="studio-scene"><LiveScene compact /></div></section>
    <Footer />
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
