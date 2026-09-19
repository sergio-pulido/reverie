import { STREAM_LIMITS } from "./streamProtocol";

/**
 * 16 kHz mono 16-bit PCM from the microphone, in frames of about 100 ms, for the live stream.
 * The browser resamples into a 16 kHz audio context, so no resampling code runs here. Frames are
 * handed on as they are made and not kept.
 */

const FRAME_SAMPLES = STREAM_LIMITS.sampleRate / 10;

// Posts each 128-sample block of channel 0 to the page. Loaded from a Blob so it ships in the bundle.
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("reverie-pcm-tap", PcmTap);
`;

/** Float samples in [-1, 1] to little-endian 16-bit PCM, clipping anything outside. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return view.buffer;
}

/** Starts the tap on `stream`. Resolves to a stop function, or null if this browser cannot do it. */
export async function capturePcm(stream: MediaStream, onFrame: (frame: ArrayBuffer) => void): Promise<(() => void) | null> {
  if (typeof AudioWorkletNode === "undefined") return null;
  let context: AudioContext | null = null;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    context = new AudioContext({ sampleRate: STREAM_LIMITS.sampleRate });
    await context.audioWorklet.addModule(url);
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, "reverie-pcm-tap");
    let pending = new Float32Array(FRAME_SAMPLES);
    let filled = 0;
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      let block = event.data;
      while (block.length > 0) {
        const take = Math.min(block.length, FRAME_SAMPLES - filled);
        pending.set(block.subarray(0, take), filled);
        filled += take;
        block = block.subarray(take);
        if (filled === FRAME_SAMPLES) {
          onFrame(toPcm16(pending));
          pending = new Float32Array(FRAME_SAMPLES);
          filled = 0;
        }
      }
    };
    // Kept in the rendered graph through a muted gain, so the tap is pulled but nothing is heard.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(context.destination);
    const running = context;
    return () => {
      if (filled > 0) onFrame(toPcm16(pending.subarray(0, filled)));
      tap.port.onmessage = null;
      source.disconnect();
      void running.close();
    };
  } catch {
    void context?.close();
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
