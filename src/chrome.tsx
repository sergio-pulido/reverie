import type { ReactNode } from "react";

export function Footer() {
  return <footer><span>REVERIE / MOVIE JAM</span><span>Made for HackBarna 2026</span><span>Every story can branch.</span></footer>;
}

export function LiveScene({ compact = false }: { compact?: boolean }) {
  return <div className={`scene-card ${compact ? "scene-card-compact" : ""}`} aria-label="Illustration of a live film jam"><div className="scene-meta"><span><i /> LIVE DIRECTION</span><span>SCENE 01 / 06</span></div><div className="moon" /><div className="mountains mountain-back" /><div className="mountains mountain-front" /><div className="character character-left"><span /></div><div className="character character-center"><span /></div><div className="character character-right"><span /></div><div className="scene-caption"><p>NOW DIRECTING</p><h2>Three friends follow a signal through the stars.</h2></div></div>;
}

/** What a Movie Jam is, told to someone about to start one. */
export function HowItWorks() {
  return <section className="steps" aria-label="How Movie Jam works"><article><span>01</span><h2>Invite the room</h2><p>Share a QR code or link. Everyone enters with a name and a point of view.</p></article><article><span>02</span><h2>Direct the turn</h2><p>Speak, write, show an image, upload a clip, or share a live reference.</p></article><article><span>03</span><h2>See it evolve</h2><p>The selected direction becomes an editable scene, screenplay, and visual world.</p></article></section>;
}

export function Notice({ tone = "alert", children }: { tone?: "alert" | "status"; children: ReactNode }) {
  return <aside className="notice" role={tone}><span className="notice-dot" />{children}</aside>;
}
