import { Footer, LiveScene, Notice } from "../chrome";
import type { JamPersistence } from "../lib/jams";
import { TopBar } from "../shell/TopBar";

/** Shown only when Supabase is absent. It never claims to be a shared room. */
export function PreviewStudio({ slug, persistence }: { slug: string; persistence: JamPersistence }) {
  return <main className="site-shell studio-shell"><TopBar current="jam" />
    <section className="studio-header"><div><p className="eyebrow">MOVIE JAM / LOCAL PREVIEW</p><h1>{slug}</h1><p>This preview is not a room. Nothing here is shared, stored, or visible to anyone else.</p></div></section>
    <Notice tone="status">{persistence === "remote" ? "This jam has no shareable room URL yet. Create the room again to get one." : <>Configure <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and apply the migrations in <code>supabase/migrations</code> to open a real room.</>}</Notice>
    <section className="studio-grid"><div className="studio-scene"><LiveScene compact /></div></section>
    <Footer />
  </main>;
}
