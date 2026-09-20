/**
 * Supabase Storage configuration shared by everything this server persists.
 *
 * The bucket is private and no public or signed URL is ever minted: bytes are
 * read here and served by our own routes, so a client never receives a storage
 * address.
 */

const DEFAULT_BUCKET = "jam-portions";

/**
 * The largest generated segment this server will accept, at the download and
 * again at the store. One number, because they are one bound: a clip too big
 * to keep is one we must not pull down either. Measured, a 15-second 768p
 * MiniMax H3 clip is under 10 MB, so this is headroom rather than a squeeze.
 */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class MediaStorageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MediaStorageError";
  }
}

export interface ObjectStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

/**
 * Storage is configured only when the server holds a service-role key. That
 * key stays on this host: it is never sent to the browser, never logged, and
 * never read by the Vercel functions, which authenticate as the caller
 * instead (`api/_lib/supabase-rest.ts`).
 */
export function resolveObjectStorageConfig(
  env: NodeJS.ProcessEnv,
): ObjectStorageConfig | null {
  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL)?.trim().replace(/\/$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  const bucket = env.REVERIE_PORTION_BUCKET?.trim() || DEFAULT_BUCKET;
  if (!SAFE_BUCKET.test(bucket)) {
    throw new MediaStorageError("REVERIE_PORTION_BUCKET is not a valid bucket name.", false);
  }
  return { url, serviceRoleKey, bucket };
}
