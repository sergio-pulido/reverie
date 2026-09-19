import { jamRoomSchema, type JamRoom } from "../core/room";
import { JamError, toJamError } from "./errors";
import { ensureUserId } from "./session";
import { hasSupabaseConfiguration, supabase } from "./supabase";

export type JamVisibility = JamRoom["visibility"];
export type JamPersistence = "remote" | "preview";
export type { JamRoom };

type CreateJamInput = Pick<JamRoom, "title" | "premise" | "visibility"> & { id?: string };
type CreatedJam = { jam: JamRoom; persistence: JamPersistence };
export type JamRegistry = { jams: JamRoom[]; persistence: JamPersistence };

// invite_code is deliberately absent: it is host-only and read through get_jam_invite.
const JAM_COLUMNS = "id, slug, title, premise, visibility, status, host_id";
const PREVIEW_REGISTRY_KEY = "reverie.preview-jams.v1";

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
    const now = new Date().toISOString();
    const jam: JamRoom = {
      id: input.id ?? crypto.randomUUID(),
      slug: `preview-${slug}`,
      title: input.title,
      premise: input.premise,
      visibility: input.visibility,
      status: "draft",
      created_at: now,
      updated_at: now,
    };
    savePreviewJam(jam);
    return {
      persistence: "preview",
      jam,
    };
  }

  const hostId = await ensureUserId("Creating a jam");
  const { data, error } = await supabase!
    .from("jams")
    .insert({ ...(input.id ? { id: input.id } : {}), slug, title: input.title, premise: input.premise, visibility: input.visibility, host_id: hostId })
    .select(JAM_COLUMNS)
    .single();

  if (error) throw toJamError(error, "The Jam room could not be created.");
  const parsed = jamRoomSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The Jam room returned an unexpected record.", true);
  return { jam: parsed.data, persistence: "remote" };
}

export async function listJams(): Promise<JamRegistry> {
  if (!hasSupabaseConfiguration()) {
    return { jams: readPreviewJams(), persistence: "preview" };
  }

  const userId = await ensureUserId("Loading your jams");
  const { data, error } = await supabase!
    .from("jams")
    .select(JAM_COLUMNS)
    .order("updated_at", { ascending: false });
  if (error) throw toJamError(error, "Your jams could not be loaded.");

  const jams = (data ?? []).flatMap((row) => {
    const parsed = jamRoomSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  // The select is already RLS-scoped to rooms this identity hosts or joined.
  void userId;
  return { jams, persistence: "remote" };
}

function readPreviewJams(): JamRoom[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(PREVIEW_REGISTRY_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((row) => {
      const parsed = jamRoomSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

function savePreviewJam(jam: JamRoom): void {
  if (typeof localStorage === "undefined") return;
  const next = [jam, ...readPreviewJams().filter((item) => item.id !== jam.id)].slice(0, 50);
  localStorage.setItem(PREVIEW_REGISTRY_KEY, JSON.stringify(next));
}
