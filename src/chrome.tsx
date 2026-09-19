import type { ReactNode } from "react";

export function Header({ onHome }: { onHome: () => void }) {
  return <nav className="topbar" aria-label="Primary navigation">
    <button className="brand brand-button" onClick={onHome} aria-label="Reverie home"><span className="brand-mark">✳</span><span>REVERIE</span></button>
    <div className="nav-links"><a href="/discover">Discover</a><button className="active" onClick={onHome}>Movie Jam</button></div>
    <span className="status"><i /> HackBarna 2026</span>
  </nav>;
}

export function Footer() {
  return <footer><span>REVERIE / MOVIE JAM</span><span>Made for HackBarna 2026</span><span>Every story can branch.</span></footer>;
}

export function LiveScene() {
  return <div className="scene-card" aria-label="Illustration of a live film jam"><div className="scene-meta"><span><i /> LIVE DIRECTION</span><span>SCENE 01 / 06</span></div><div className="moon" /><div className="mountains mountain-back" /><div className="mountains mountain-front" /><div className="character character-left"><span /></div><div className="character character-center"><span /></div><div className="character character-right"><span /></div><div className="scene-caption"><p>NOW DIRECTING</p><h2>Three friends follow a signal through the stars.</h2></div></div>;
}

export function Notice({ tone = "alert", children }: { tone?: "alert" | "status"; children: ReactNode }) {
  return <aside className="notice" role={tone}><span className="notice-dot" />{children}</aside>;
}
