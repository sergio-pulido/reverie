import {
  MediaStorageError,
  resolveObjectStorageConfig,
  type ObjectStorageConfig,
} from "./objectStorage";

/**
 * The reproduction record for director sessions.
 *
 * The bytes in the bucket are not enough to reproduce a session: they do not
 * say which configuration was being watched, which script revision produced
 * them, what the room asked for, or what fal did with each direction. This
 * holds that, and it is deliberately separate from the media store.
 *
 * Everything here is written AS IT HAPPENS rather than at the end. The
 * segmenter delivers `finish()` fire-and-forget and nothing awaits it, so a
 * record that were only written when a session closed would be lost in exactly
 * the case it is most needed — a process that died mid-stream.
 *
 * `durable` is reported honestly, as the media store does. Without a
 * service-role key this is in-memory and dies with the process, and the API
 * says so rather than implying an archive that does not exist.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/** Bounded so a long-running server cannot grow without limit. */
const MAX_IN_MEMORY_SESSIONS = 32;
/** Matches MAX_AUDIT_ENTRIES_PER_SESSION: one session cannot flood the table. */
const MAX_AUDIT_ROWS_PER_SESSION = 500;

export interface DirectorSessionRecord {
  id: string;
  jamId: string;
  configurationKey: string;
  scriptRevision: number | null;
  codec: string | null;
  container: string | null;
  startedAt: string;
  endedAt: string | null;
  complete: boolean;
  truncatedReason: string | null;
}

export interface DirectorSegmentRecord {
  segmentIndex: number;
  startSeconds: number;
  durationSeconds: number;
  byteSize: number;
  objectPath: string;
}

export interface DirectorAuditRecord {
  at: string;
  kind: string;
  promptVersion?: number;
  chunkIndex?: number;
  scriptOffsetSeconds?: number;
  proposalId?: string;
  beatIndex?: number;
  authorId?: string;
  body?: string;
  detail?: string;
}

export interface OpenSessionInput {
  id: string;
  jamId: string;
  configurationKey: string;
  scriptRevision?: number | null;
}

export interface DirectorIndexStore {
  readonly durable: boolean;
  openSession(input: OpenSessionInput): Promise<void>;
  describeStream(id: string, codec: string, container: string): Promise<void>;
  recordSegment(id: string, segment: DirectorSegmentRecord): Promise<void>;
  recordAudit(id: string, entry: DirectorAuditRecord): Promise<void>;
  closeSession(id: string, truncatedReason?: string | null): Promise<void>;
  listSessions(jamId: string): Promise<DirectorSessionRecord[]>;
  getSession(id: string): Promise<DirectorSessionRecord | null>;
  listSegments(id: string): Promise<DirectorSegmentRecord[]>;
  listAudit(id: string): Promise<DirectorAuditRecord[]>;
}

interface MemorySession {
  record: DirectorSessionRecord;
  segments: Map<number, DirectorSegmentRecord>;
  audit: DirectorAuditRecord[];
}

export class InMemoryDirectorIndexStore implements DirectorIndexStore {
  readonly durable = false;
  private readonly sessions = new Map<string, MemorySession>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async openSession(input: OpenSessionInput): Promise<void> {
    if (this.sessions.size >= MAX_IN_MEMORY_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(input.id, {
      record: {
        id: input.id,
        jamId: input.jamId,
        configurationKey: input.configurationKey,
        scriptRevision: input.scriptRevision ?? null,
        codec: null,
        container: null,
        startedAt: this.clock().toISOString(),
        endedAt: null,
        complete: false,
        truncatedReason: null,
      },
      segments: new Map(),
      audit: [],
    });
  }

  async describeStream(id: string, codec: string, container: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.record = { ...session.record, codec, container };
  }

  async recordSegment(id: string, segment: DirectorSegmentRecord): Promise<void> {
    this.sessions.get(id)?.segments.set(segment.segmentIndex, segment);
  }

  async recordAudit(id: string, entry: DirectorAuditRecord): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.audit.push(entry);
    if (session.audit.length > MAX_AUDIT_ROWS_PER_SESSION) session.audit.shift();
  }

  async closeSession(id: string, truncatedReason?: string | null): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.record = {
      ...session.record,
      endedAt: this.clock().toISOString(),
      complete: true,
      truncatedReason: truncatedReason ?? session.record.truncatedReason,
    };
  }

  async listSessions(jamId: string): Promise<DirectorSessionRecord[]> {
    return [...this.sessions.values()]
      .map((session) => session.record)
      .filter((record) => record.jamId === jamId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async getSession(id: string): Promise<DirectorSessionRecord | null> {
    return this.sessions.get(id)?.record ?? null;
  }

  async listSegments(id: string): Promise<DirectorSegmentRecord[]> {
    const segments = this.sessions.get(id)?.segments;
    return segments
      ? [...segments.values()].sort((left, right) => left.segmentIndex - right.segmentIndex)
      : [];
  }

  async listAudit(id: string): Promise<DirectorAuditRecord[]> {
    return this.sessions.get(id)?.audit ?? [];
  }
}

/**
 * The durable index, over PostgREST with the service-role key.
 *
 * This is the first thing the container server writes to Postgres. The Vercel
 * functions deliberately never hold a service-role key and authenticate as the
 * caller instead (`api/_lib/supabase-rest.ts`); this server does hold one, and
 * the tables it writes carry RLS with no policies, so the key is the only way
 * in. Nothing here is reachable by a browser identity.
 */
export class SupabaseDirectorIndexStore implements DirectorIndexStore {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ObjectStorageConfig,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async openSession(input: OpenSessionInput): Promise<void> {
    await this.write("POST", "/rest/v1/jam_director_sessions", [
      {
        id: input.id,
        jam_id: input.jamId,
        configuration_key: input.configurationKey,
        script_revision: input.scriptRevision ?? null,
      },
    ], "resolution=merge-duplicates");
  }

  async describeStream(id: string, codec: string, container: string): Promise<void> {
    await this.write(
      "PATCH",
      `/rest/v1/jam_director_sessions?id=eq.${encodeURIComponent(id)}`,
      { codec, container },
    );
  }

  /**
   * Records a segment that is already in the bucket.
   *
   * Upserted rather than inserted so a retried upload does not fail the row,
   * and only ever called AFTER a successful upload — a playlist built from
   * these rows must never point at an object that is not there.
   */
  async recordSegment(id: string, segment: DirectorSegmentRecord): Promise<void> {
    await this.write("POST", "/rest/v1/jam_director_segments", [
      {
        session_id: id,
        segment_index: segment.segmentIndex,
        start_seconds: segment.startSeconds,
        duration_seconds: segment.durationSeconds,
        byte_size: segment.byteSize,
        object_path: segment.objectPath,
      },
    ], "resolution=merge-duplicates");
  }

  async recordAudit(id: string, entry: DirectorAuditRecord): Promise<void> {
    await this.write("POST", "/rest/v1/jam_director_audit", [
      {
        session_id: id,
        at: entry.at,
        kind: entry.kind,
        prompt_version: entry.promptVersion ?? null,
        chunk_index: entry.chunkIndex ?? null,
        script_offset_seconds: entry.scriptOffsetSeconds ?? null,
        proposal_id: entry.proposalId ?? null,
        beat_index: entry.beatIndex ?? null,
        author_id: entry.authorId ?? null,
        body: entry.body ?? null,
        detail: entry.detail ?? null,
      },
    ]);
  }

  async closeSession(id: string, truncatedReason?: string | null): Promise<void> {
    await this.write(
      "PATCH",
      `/rest/v1/jam_director_sessions?id=eq.${encodeURIComponent(id)}`,
      {
        ended_at: new Date().toISOString(),
        complete: true,
        ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
      },
    );
  }

  async listSessions(jamId: string): Promise<DirectorSessionRecord[]> {
    const rows = await this.read(
      `/rest/v1/jam_director_sessions?jam_id=eq.${encodeURIComponent(jamId)}` +
        "&order=started_at.desc&limit=100",
    );
    return rows.map(toSessionRecord);
  }

  async getSession(id: string): Promise<DirectorSessionRecord | null> {
    const rows = await this.read(
      `/rest/v1/jam_director_sessions?id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    return rows.length ? toSessionRecord(rows[0]) : null;
  }

  async listSegments(id: string): Promise<DirectorSegmentRecord[]> {
    const rows = await this.read(
      `/rest/v1/jam_director_segments?session_id=eq.${encodeURIComponent(id)}` +
        "&order=segment_index.asc",
    );
    return rows.map((row) => ({
      segmentIndex: Number(row.segment_index),
      startSeconds: Number(row.start_seconds),
      durationSeconds: Number(row.duration_seconds),
      byteSize: Number(row.byte_size),
      objectPath: String(row.object_path),
    }));
  }

  async listAudit(id: string): Promise<DirectorAuditRecord[]> {
    const rows = await this.read(
      `/rest/v1/jam_director_audit?session_id=eq.${encodeURIComponent(id)}` +
        `&order=at.asc,id.asc&limit=${MAX_AUDIT_ROWS_PER_SESSION}`,
    );
    return rows.map((row) => ({
      at: String(row.at),
      kind: String(row.kind),
      promptVersion: nullableNumber(row.prompt_version),
      chunkIndex: nullableNumber(row.chunk_index),
      scriptOffsetSeconds: nullableNumber(row.script_offset_seconds),
      proposalId: nullableString(row.proposal_id),
      beatIndex: nullableNumber(row.beat_index),
      authorId: nullableString(row.author_id),
      body: nullableString(row.body),
      detail: nullableString(row.detail),
    }));
  }

  private async read(path: string): Promise<Record<string, unknown>[]> {
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw new MediaStorageError(
        "The director index could not be read.",
        response.status >= 500,
      );
    }
    const body = await response.json();
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  }

  private async write(
    method: string,
    path: string,
    body: unknown,
    prefer?: string,
  ): Promise<void> {
    const response = await this.request(method, path, body, prefer);
    if (!response.ok) {
      // PostgREST's body can name columns and constraints; it is never
      // forwarded, so the failure stays honest without leaking the schema.
      throw new MediaStorageError(
        "The director index could not be written.",
        response.status >= 500,
      );
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.config.url}${path}`, {
        method,
        headers: {
          apikey: this.config.serviceRoleKey,
          authorization: `Bearer ${this.config.serviceRoleKey}`,
          "content-type": "application/json",
          // `return=minimal` keeps written rows out of the response: nothing
          // here needs them back, and a direction body is not worth echoing.
          prefer: prefer ? `${prefer},return=minimal` : "return=minimal",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MediaStorageError("The director index could not be reached.", true);
    }
  }
}

function toSessionRecord(row: Record<string, unknown>): DirectorSessionRecord {
  return {
    id: String(row.id),
    jamId: String(row.jam_id),
    configurationKey: String(row.configuration_key),
    scriptRevision: nullableNumber(row.script_revision) ?? null,
    codec: nullableString(row.codec) ?? null,
    container: nullableString(row.container) ?? null,
    startedAt: String(row.started_at),
    endedAt: nullableString(row.ended_at) ?? null,
    complete: row.complete === true,
    truncatedReason: nullableString(row.truncated_reason) ?? null,
  };
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** Durable when a service-role key is configured, memory otherwise. */
export function resolveDirectorIndexStore(
  env: NodeJS.ProcessEnv = process.env,
): DirectorIndexStore {
  const config = resolveObjectStorageConfig(env);
  return config
    ? new SupabaseDirectorIndexStore(config)
    : new InMemoryDirectorIndexStore();
}
