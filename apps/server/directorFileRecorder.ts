import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaStreamTrack } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import type { DirectorTrackConsumer } from "./directorSegmenter";

/**
 * Records the inbound track to a WebM file and stores it when the session ends.
 *
 * This is the recording behaviour the director shipped with, moved behind the
 * track-consumer seam without changing what it does. It writes to disk rather
 * than streaming into the media store because the container has to finalize its
 * headers on close; a half-written WebM in object storage is an unplayable
 * object.
 *
 * It is deliberately a peer of the segmenter rather than its owner: a session
 * can record without delivering live, or deliver live without recording, and
 * neither failure should take the other down.
 */

/** Where a finished recording goes. An interface so a test fake fits. */
export interface DirectorRecordingSink {
  save(jamId: string, sessionId: string, bytes: Buffer, contentType: string): Promise<void>;
}

export class DirectorFileRecorder implements DirectorTrackConsumer {
  private recorder: MediaRecorder | null = null;
  private directory: string | null = null;
  private path: string | null = null;
  private stopped = false;

  constructor(
    private readonly jamId: string,
    private readonly sessionId: string,
    private readonly sink: DirectorRecordingSink | undefined,
  ) {}

  async addTrack(track: MediaStreamTrack): Promise<void> {
    if (this.stopped) return;
    if (this.recorder) {
      await this.recorder.addTrack(track);
      return;
    }
    this.directory = await mkdtemp(join(tmpdir(), "reverie-director-"));
    this.path = join(this.directory, `${this.sessionId}.webm`);
    this.recorder = new MediaRecorder({ path: this.path, tracks: [track] });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.recorder?.stop();
    } catch {
      // A recorder that never received a frame throws on stop; the session is
      // ending either way and the failure must not mask the real reason.
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const path = this.path;
    const directory = this.directory;
    this.path = null;
    this.directory = null;
    if (!path || !directory) return;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 0) {
        await this.sink?.save(this.jamId, this.sessionId, bytes, "video/webm");
      }
    } catch {
      // Losing the recording must not prevent the session from closing and
      // releasing its budget reservation.
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
