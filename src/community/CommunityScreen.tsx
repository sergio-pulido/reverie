import { Footer } from "../chrome";
import { TopBar } from "../shell/TopBar";

/**
 * The community's own screen, opened by this slice so a later one has somewhere to build. It
 * reads nothing: what the rooms around you are making arrives with the slice that replaces
 * this body.
 */
export function CommunityScreen() {
  return <main className="site-shell placeholder-shell"><TopBar current="community" />
    <section className="placeholder-layout">
      <p className="eyebrow">COMMUNITY</p>
      <h1>Community</h1>
      <p className="intro">This page is being built.</p>
    </section>
    <Footer />
  </main>;
}
