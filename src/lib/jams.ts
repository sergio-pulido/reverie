import { hasSupabaseConfiguration, supabase } from "./supabase";

export type JamVisibility = "public" | "invite_only";
export type JamPersistence = "remote" | "preview";

export type Jam = {
  id: string;
  slug: string;
  title: string;
  premise: string;
  visibility: JamVisibility;
  status: "draft" | "lobby" | "live" | "paused" | "completed" | "closed";
};

type CreateJamInput = Pick<Jam, "title" | "premise" | "visibility">;
type CreatedJam = { jam: Jam; persistence: JamPersistence };

function createSlug(title: string) {
  const base = title.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "movie-jam";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function currentUserId() {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user) return sessionData.session.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) throw new Error(error?.message ?? "Anonymous sign-in could not start.");
  return data.user.id;
}

export async function createJam(input: CreateJamInput): Promise<CreatedJam> {
  const slug = createSlug(input.title);
  if (!hasSupabaseConfiguration()) {
    return { persistence: "preview", jam: { id: `preview-${slug}`, slug, title: input.title, premise: input.premise, visibility: input.visibility, status: "draft" } };
  }

  const hostId = await currentUserId();
  const { data, error } = await supabase!
    .from("jams")
    .insert({ slug, title: input.title, premise: input.premise, visibility: input.visibility, host_id: hostId })
    .select("id, slug, title, premise, visibility, status")
    .single();

  if (error || !data) throw new Error(error?.message ?? "The Jam room could not be created.");
  return { jam: data as Jam, persistence: "remote" };
}

export async function getJam(slug: string): Promise<Jam | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("jams")
    .select("id, slug, title, premise, visibility, status")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Jam | null;
}
