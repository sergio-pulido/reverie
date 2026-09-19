export function Header({ onHome }: { onHome: () => void }) {
  return <nav className="topbar" aria-label="Primary navigation">
    <button className="brand brand-button" onClick={onHome} aria-label="Reverie home"><span className="brand-mark">✳</span><span>REVERIE</span></button>
    <div className="nav-links"><button className="active" onClick={onHome}>Discover</button><button onClick={onHome}>Movie Jam</button></div>
    <span className="status"><i /> HackBarna 2026</span>
  </nav>;
}

export function Footer() {
  return <footer><span>REVERIE / MOVIE JAM</span><span>Made for HackBarna 2026</span><span>Every story can branch.</span></footer>;
}
