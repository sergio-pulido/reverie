import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Notice = "create" | "join" | null;

function App() {
  const [notice, setNotice] = useState<Notice>(null);
  const message = notice === "create"
    ? "Room creation is the next build step. The host experience starts here."
    : "Joining by link or QR is the next build step. Bring your audience in soon.";

  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Primary navigation">
        <a className="brand" href="/" aria-label="Reverie home"><span className="brand-mark">✳</span><span>REVERIE</span></a>
        <div className="nav-links"><a className="active" href="#jam">Movie Jam</a><a href="#how-it-works">How it works</a><a href="#manifesto">Manifesto</a></div>
        <span className="status"><i /> HackBarna 2027</span>
      </nav>

      <section className="hero" id="jam">
        <div className="hero-copy">
          <p className="eyebrow">A LIVE COLLABORATIVE FILM STUDIO</p>
          <h1>Make the next scene <em>together.</em></h1>
          <p className="intro">A Movie Jam turns every guest into a director. Add an idea, shape the cast, vote on the turn, and watch an original film find its way.</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => setNotice("create")}>Start a Movie Jam <span>↗</span></button>
            <button className="button button-quiet" onClick={() => setNotice("join")}>Join with an invite <span>→</span></button>
          </div>
          {notice && <aside className="notice" role="status"><span className="notice-dot" />{message}<button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></aside>}
        </div>

        <div className="scene-card" aria-label="Illustration of a live film jam">
          <div className="scene-meta"><span><i /> LIVE DIRECTION</span><span>SCENE 01 / 06</span></div>
          <div className="moon" /><div className="mountains mountain-back" /><div className="mountains mountain-front" />
          <div className="character character-left"><span /></div><div className="character character-center"><span /></div><div className="character character-right"><span /></div>
          <div className="scene-caption"><p>NOW DIRECTING</p><h2>Three friends follow a signal through the stars.</h2></div>
        </div>
      </section>

      <section className="steps" id="how-it-works" aria-label="How Movie Jam works">
        <article><span>01</span><h2>Invite the room</h2><p>Share a QR code or link. Everyone enters with a name and a point of view.</p></article>
        <article><span>02</span><h2>Direct the turn</h2><p>Speak or write anything from a tiny twist to a complete world and character brief.</p></article>
        <article><span>03</span><h2>See it evolve</h2><p>The winning direction becomes editable script, scene design and generated cinema.</p></article>
      </section>

      <footer id="manifesto"><span>REVERIE / MOVIE JAM</span><span>Made for HackBarna 2027</span><span>Every story can branch.</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
