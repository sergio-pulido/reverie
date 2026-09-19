import { Footer } from "../chrome";
import { TopBar } from "../shell/TopBar";

/**
 * The catalogue's own screen, opened by this slice so a later one has somewhere to build. It
 * reads nothing: the browsable catalogue arrives with the slice that replaces this body.
 */
export function CatalogScreen() {
  return <main className="site-shell placeholder-shell"><TopBar current="catalog" />
    <section className="placeholder-layout">
      <p className="eyebrow">CATALOG</p>
      <h1>Catalog</h1>
      <p className="intro">This page is being built.</p>
    </section>
    <Footer />
  </main>;
}
