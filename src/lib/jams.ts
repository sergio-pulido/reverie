import { jamRoomSchema, type JamRoom } from "../core/room";
import { JamError, toJamError } from "./errors";
import { ensureUserId } from "./session";
import { hasSupabaseConfiguration, supabase } from "./supabase";

export type JamVisibility = JamRoom["visibility"];
export type JamPersistence = "remote" | "preview";
export type { JamRoom };

type CreateJamInput = Pick<JamRoom, "title" | "premise" | "visibility">;
type CreatedJam = { jam: JamRoom; persistence: JamPersistence };

const JAM_COLUMNS = "id, slug, title, premise, visibility, status, host_id, invite_code";

function createSlug(title: string) {
  const base = title.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "movie-jam";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createJam(input: CreateJamInput): Promise<CreatedJam> {
  const slug = createSlug(input.title);
  if (!hasSupabaseConfiguration()) {
    return {
      persistence: "preview",
      jam: { id: `preview-${slug}`, slug, title: input.title, premise: input.premise, visibility: input.visibility, status: "draft" },
    };
  }

  const hostId = await ensureUserId("Creating a jam");
  const { data, error } = await supabase!
    .from("jams")
    .insert({ slug, title: input.title, premise: input.premise, visibility: input.visibility, host_id: hostId })
    .select(JAM_COLUMNS)
    .single();

  if (error) throw toJamError(error, "The Jam room could not be created.");
  const parsed = jamRoomSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The Jam room returned an unexpected record.", true);
  return { jam: parsed.data, persistence: "remote" };
}
