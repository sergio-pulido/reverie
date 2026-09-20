/**
 * Where the pieces of an archived director session live, and what they are.
 *
 * Pure, and in `core` rather than beside the sink that writes them, because
 * two hosts now read this layout: the container's own archive routes and the
 * Vercel function that serves a finished film in production. A second copy of
 * these names would be a second answer to "which object holds piece 3", and
 * the one that was wrong would answer 404 with no way to tell why.
 */

/**
 * The container the muxer produced. Codec selection happens before storage, so
 * keys and content types never have to guess from the payload.
 */
export type ArchiveContainer = "webm" | "mp4";

const CONTAINERS: Record<ArchiveContainer, { init: string; piece: string; contentType: string }> = {
  webm: { init: "init.webm", piece: "webm", contentType: "video/webm" },
  mp4: { init: "init.mp4", piece: "m4s", contentType: "video/mp4" },
};

/** The key a piece is stored under, given its container. */
export function pieceObjectName(container: ArchiveContainer, index: number): string {
  return `${index}.${CONTAINERS[container].piece}`;
}

export function initObjectName(container: ArchiveContainer): string {
  return CONTAINERS[container].init;
}

export function containerContentType(container: ArchiveContainer): string {
  return CONTAINERS[container].contentType;
}

/**
 * A stored session says which container it used; an archive written before
 * that was recorded is fMP4, the only container the archive produced then.
 */
export function asContainer(value: string | null | undefined): ArchiveContainer {
  return value === "webm" ? "webm" : "mp4";
}
