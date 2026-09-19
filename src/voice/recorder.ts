import { capturePcm } from "./pcmCapture";
import type { MicrophoneFailure } from "./voiceState";

/**
 * Browser capture of one spoken request. The recording lives in memory only: it is handed to
 * the transcription call and dropped, and the microphone is released as soon as it stops.
 */

/** Opus at 32 kbps is clear for speech and about an eighth of the bytes of 16 kHz PCM. */
const AUDIO_BITS_PER_SECOND = 32_000;
/** Preferred first; Safari records MP4/AAC, the rest Opus. */
const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"] as const;

export class MicrophoneError extends Error {
  constructor(readonly failure: MicrophoneFailure) {
    super(failure);
    this.name = "MicrophoneError";
  }
}

export type Recording = {
  /** Stops capture and resolves to the audio, with its container type. */
  stop: () => Promise<Blob>;
  /** Stops capture and discards the audio. */
  cancel: () => void;
  /** True when PCM frames are also being delivered for the live stream. */
  streaming: boolean;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function classify(error: unknown): MicrophoneFailure {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unknown";
}

/** Reports the input level (0–1) about 30 times a second until `stop` is called. */
function watchLevel(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return () => undefined;
  const context = new AudioContextClass();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    // Speech RMS sits around 0.02–0.2; scale so normal talking fills most of the meter.
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
  }, 33);
  return () => {
    window.clearInterval(timer);
    void context.close();
  };
}

/**
 * Opens the microphone and records. With `onPcm`, the same audio is also delivered as 16 kHz PCM
 * frames for the live stream; the recording is always kept too, so the upload path can take over.
 */
export async function startRecording(onLevel: (level: number) => void, onPcm?: (frame: ArrayBuffer) => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new MicrophoneError("unsupported");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new MicrophoneError(classify(error));
  }

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new MicrophoneError("unsupported");
  }

  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopLevel = watchLevel(stream, onLevel);
  const stopPcm = onPcm ? await capturePcm(stream, onPcm) : null;
  const release = () => {
    stopPcm?.();
    stopLevel();
    stream.getTracks().forEach((track) => track.stop());
  };
  recorder.start();

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
            chunks.length = 0;
          },
          { once: true },
        );
        if (recorder.state === "inactive") recorder.dispatchEvent(new Event("stop"));
        else recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      chunks.length = 0;
      release();
    },
    streaming: stopPcm !== null,
  };
}
