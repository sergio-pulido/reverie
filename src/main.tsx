import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Screen = "home" | "create" | "join" | "studio";
type Contribution = { author: string; text: string; kind: "host" | "director" };

const starterContributions: Contribution[] = [
  { author: "Reverie", text: "Set a premise, invite the room, then collect the first turn.", kind: "director" },
  { author: "You", text: "The story begins with a signal arriving from beyond the screen.", kind: "host" },
];

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [roomTitle, setRoomTitle] = useState("Untitled Movie Jam");
  const [premise, setPremise] = useState("A signal changes what the room thinks is possible.");
  const [visibility, setVisibility] = useState("Invite only");
  const [contributions, setContributions] = useState(starterContributions);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContributions([
      { author: "Reverie", text: "The room is ready. Add the first direction when your guests arrive.", kind: "director" },
      { author: "You", text: premise, kind: "host" },
    ]);
    setScreen("studio");
  }

  function addContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setContributions((items) => [...items, { author: "You", text, kind: "host" }]);
    setDraft("");
  }

  if (screen === "create") {
    return <CreateRoom title={roomTitle} premise={premise} visibility={visibility} onTitle={setRoomTitle} onPremise={setPremise} onVisibility={setVisibility} onBack={() => setScreen("home")} onSubmit={createRoom} />;
  }

  if (screen === "join") {
    return <JoinRoom onBack={() => setScreen("home")} onJoin={() => setNotice("Live invitations will connect to server-owned rooms in the next build step.")} notice={notice} />;
  }

  if (screen === "studio") {
    return <Studio title={roomTitle} visibility={visibility} contributions={contributions} draft={draft} onDraft={setDraft} onSubmit={addContribution} onExit={() => setScreen("home")} />;
  }

  return <Home onCreate={() => setScreen("create")} onJoin={() => setScreen("join")} />;
}

function Header({ onHome }: { onHome: () => void }) {
  return <nav className="topbar" aria-label="Primary navigation">
    <button className="brand brand-button" onClick={onHome} aria-label="Reverie home"><span className="brand-mark">✳</span><span>REVERIE</span></button>
    <div className="nav-links"><button className="active" onClick={onHome}>Discover</button><button onClick={onHome}>Movie Jam</button></div>
    <span className="status"><i /> HackBarna 2026</span>
  </nav>;
}

function Home({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return <main className="site-shell">
    <Header onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
    <section className="hero" id="jam">
      <div className="hero-copy">
        <p className="eyebrow">A LIVE COLLABORATIVE FILM STUDIO</p>
        <h1>Make the next scene <em>together.</em></h1>
        <p className="intro">Start a room, invite the people around you, and direct a new story one clear turn at a time.</p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={onCreate}>Start a Movie Jam <span>↗</span></button>
          <button className="button button-quiet" onClick={onJoin}>Join with an invite <span>→</span></button>
        </div>
      </div>
      <LiveScene />
    </section>
    <section className="steps" aria-label="How Movie Jam works">
      <article><span>01</span><h2>Invite the room</h2><p>Share a QR code or link. Everyone enters with a name and a point of view.</p></article>
      <article><span>02</span><h2>Direct the turn</h2><p>Speak, write, show an image, upload a clip, or share a live reference.</p></article>
      <article><span>03</span><h2>See it evolve</h2><p>The selected direction becomes an editable scene, screenplay, and visual world.</p></article>
    </section>
    <Footer />
  </main>;
}

type CreateRoomProps = {
  title: string; premise: string; visibility: string;
  onTitle: (value: string) => void; onPremise: (value: string) => void; onVisibility: (value: string) => void;
  onBack: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function CreateRoom({ title, premise, visibility, onTitle, onPremise, onVisibility, onBack, onSubmit }: CreateRoomProps) {
  return <main className="site-shell setup-shell"><Header onHome={onBack} />
    <section className="setup-layout">
      <div className="setup-intro"><button className="back-link" onClick={onBack}>← Back to Reverie</button><p className="eyebrow">NEW MOVIE JAM</p><h1>Set the first <em>scene.</em></h1><p className="intro">This is the host's opening direction. Guests can shape what happens next once the room opens.</p></div>
      <form className="room-form" onSubmit={onSubmit}>
        <label>Jam title<input value={title} onChange={(event) => onTitle(event.target.value)} maxLength={72} required /></label>
        <label>Opening premise<textarea value={premise} onChange={(event) => onPremise(event.target.value)} maxLength={280} required /></label>
        <label>Who can join?<select value={visibility} onChange={(event) => onVisibility(event.target.value)}><option>Invite only</option><option>Public room</option></select></label>
        <p className="form-note">The room opens in local preview for now. Shared sessions, invitations, and voting come next.</p>
        <button className="button button-primary form-submit" type="submit">Create the room <span>↗</span></button>
      </form>
    </section><Footer />
  </main>;
}

function JoinRoom({ onBack, onJoin, notice }: { onBack: () => void; onJoin: () => void; notice: string | null }) {
  return <main className="site-shell setup-shell"><Header onHome={onBack} />
    <section className="join-layout"><div className="join-card"><button className="back-link" onClick={onBack}>← Back to Reverie</button><p className="eyebrow">JOIN A MOVIE JAM</p><h1>Take a seat in the <em>room.</em></h1><p className="intro">Enter the invite link or room code shared by the host.</p><label>Invite link or room code<input placeholder="reverie.tv/jam/…" /></label><label>Your display name<input placeholder="Your name" /></label><button className="button button-primary form-submit" onClick={onJoin}>Join the room <span>→</span></button>{notice && <aside className="notice" role="status"><span className="notice-dot" />{notice}<button onClick={onBack} aria-label="Dismiss message">×</button></aside>}</div></section><Footer />
  </main>;
}

function Studio({ title, visibility, contributions, draft, onDraft, onSubmit, onExit }: { title: string; visibility: string; contributions: Contribution[]; draft: string; onDraft: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onExit: () => void }) {
  return <main className="site-shell studio-shell"><Header onHome={onExit} />
    <section className="studio-header"><div><p className="eyebrow">MOVIE JAM / HOST PREVIEW</p><h1>{title}</h1><p>{visibility} · Scene 01 is waiting for the room.</p></div><div className="studio-actions"><button className="button button-quiet" onClick={onExit}>Exit preview</button><button className="button button-primary" onClick={() => window.alert("The invite QR appears once server-owned rooms are connected.")}>Invite guests <span>↗</span></button></div></section>
    <section className="studio-grid">
      <aside className="conversation-panel"><div className="panel-heading"><div><p className="eyebrow">STORY CONVERSATION</p><h2>What should happen next?</h2></div><span className="local-badge">LOCAL</span></div>
        <div className="contribution-list" aria-live="polite">{contributions.map((item, index) => <article className={`contribution ${item.kind}`} key={`${item.author}-${index}`}><span>{item.author}</span><p>{item.text}</p></article>)}</div>
        <form className="contribution-form" onSubmit={onSubmit}><label className="sr-only" htmlFor="direction">Propose a story direction</label><textarea id="direction" value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Add a character, twist, shot, or feeling…" maxLength={280} /><button className="button button-primary" type="submit">Propose <span>↗</span></button></form>
      </aside>
      <div className="studio-scene"><LiveScene compact /><div className="queue-card"><div><p className="eyebrow">UP NEXT</p><h2>Proposals join the queue.</h2></div><p>Voting and scene transitions will be synchronized when the room server is connected.</p></div></div>
    </section><Footer />
  </main>;
}

function LiveScene({ compact = false }: { compact?: boolean }) {
  return <div className={`scene-card ${compact ? "scene-card-compact" : ""}`} aria-label="Illustration of a live film jam"><div className="scene-meta"><span><i /> LIVE DIRECTION</span><span>SCENE 01 / 06</span></div><div className="moon" /><div className="mountains mountain-back" /><div className="mountains mountain-front" /><div className="character character-left"><span /></div><div className="character character-center"><span /></div><div className="character character-right"><span /></div><div className="scene-caption"><p>NOW DIRECTING</p><h2>Three friends follow a signal through the stars.</h2></div></div>;
}

function Footer() { return <footer><span>REVERIE / MOVIE JAM</span><span>Made for HackBarna 2026</span><span>Every story can branch.</span></footer>; }

createRoot(document.getElementById("root")!).render(<App />);
