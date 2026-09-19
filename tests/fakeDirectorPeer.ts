import type {
  DirectorControlChannel,
  DirectorPeer,
} from "../apps/server/directorStream";

/**
 * A peer connection that never touches the network.
 *
 * Route tests care about what the server sends and records, not about ICE. A
 * real werift peer also keeps the Node event loop alive, which hangs the test
 * runner, so the seam exists as much for testability as for speed.
 */
export class FakeControlChannel implements DirectorControlChannel {
  readyState = "connecting";
  /** Everything the server sent to the provider, in order. */
  readonly sent: string[] = [];
  private readonly messageListeners: ((raw: unknown) => void)[] = [];
  private readonly stateListeners: ((state: string) => void)[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  onMessage = {
    subscribe: (listener: (raw: unknown) => void) => {
      this.messageListeners.push(listener);
      return null;
    },
  };

  stateChanged = {
    subscribe: (listener: (state: string) => void) => {
      this.stateListeners.push(listener);
      return null;
    },
  };

  /** Drives the channel open, which makes the server send `configure`. */
  open(): void {
    this.readyState = "open";
    for (const listener of this.stateListeners) listener("open");
  }

  /** Delivers a message as if fal had sent it. */
  deliver(message: unknown): void {
    const raw = JSON.stringify(message);
    for (const listener of this.messageListeners) listener(raw);
  }

  /** Parsed view of what was sent, for assertions. */
  parsed(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry));
  }
}

export class FakeDirectorPeer implements DirectorPeer {
  readonly channel = new FakeControlChannel();
  readonly transceivers: string[] = [];
  localDescription: { sdp: string } | undefined;
  iceGatheringState = "complete";
  closed = false;
  remoteSdp: string | null = null;
  label: string | null = null;

  addTransceiver(kind: "video" | "audio"): unknown {
    this.transceivers.push(kind);
    return null;
  }

  createDataChannel(label: string): DirectorControlChannel {
    this.label = label;
    return this.channel;
  }

  async createOffer(): Promise<{ sdp: string }> {
    return { sdp: "v=0\r\nfake-offer\r\n" };
  }

  async setLocalDescription(offer: { sdp: string }): Promise<unknown> {
    this.localDescription = offer;
    return null;
  }

  async setRemoteDescription(answer: { type: "answer"; sdp: string }): Promise<unknown> {
    this.remoteSdp = answer.sdp;
    return null;
  }

  onTrack = { subscribe: () => null };
  iceGatheringStateChange = { subscribe: () => null };

  close(): unknown {
    this.closed = true;
    return null;
  }
}
