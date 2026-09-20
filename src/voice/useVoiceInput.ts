import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VOICE_LIMITS } from "./contract";
import { MicrophoneError, startRecording, type Recording } from "./recorder";
import { openStream, type StreamSession } from "./streamClient";
import { requestTranscript } from "./voiceClient";
import { mergePartial } from "./partialMerge";
import { MICROPHONE_MESSAGES, outcomeOf, pressAction, streamedAnswer, type VoicePhase } from "./voiceState";

type VoiceInputOptions = {
  /** A final transcript, for the conversation field. Never sent as a turn from here. */
  onTranscript: (text: string) => void;
};

/**
 * Press to talk. One press opens the microphone and records; the next press (or the time limit)
 * stops and hands the final transcript back. While recording, the audio also streams to the
 * server and what has been heard so far comes back as `partial`, for the screen only: each new
 * partial is merged into it where the two overlap, never laid end to end. On stop the
 * stream's final is used when it has words; otherwise the recording, kept all along, is uploaded.
 * Every failure ends in a plain notice and the idle state, so typing always keeps working.
 *
 * Latency is recorded with the User Timing API: `voice:first-partial` runs from recording start
 * to the first partial, and `voice:stop-to-transcript` from the moment recording stops to the
 * moment the transcript (or notice) is back, with the path taken and the sizes in its detail.
 */
export function useVoiceInput({ onTranscript }: VoiceInputOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const recording = useRef<Recording | null>(null);
  const stream = useRef<StreamSession | null>(null);
  const phaseRef = useRef<VoicePhase>("idle");
  const deadline = useRef<number | null>(null);
  const deliver = useRef(onTranscript);
  deliver.current = onTranscript;
  const mounted = useRef(true);

  const moveTo = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }, []);

  const clearDeadline = () => {
    if (deadline.current !== null) window.clearInterval(deadline.current);
    deadline.current = null;
  };

  const stop = useCallback(async () => {
    const active = recording.current;
    if (!active || phaseRef.current !== "recording") return;
    recording.current = null;
    clearDeadline();
    moveTo("transcribing");
    setLevel(0);
    performance.mark("voice:stop");
    const session = stream.current;
    stream.current = null;
    // The recorder flushes its last PCM frame on stop, so the stream is told to finish after it.
    const audio = await active.stop();
    const streamed = session && active.streaming ? await session.finish() : null;
    if (!active.streaming) session?.cancel();
    const fromStream = streamedAnswer(streamed);
    const answer = fromStream ?? (await requestTranscript(audio));
    performance.measure("voice:stop-to-transcript", {
      start: "voice:stop",
      detail: {
        path: fromStream ? "stream" : "upload",
        streamResult: streamed ? (streamed.kind === "final" ? "final" : streamed.code) : "none",
        streamTimings: streamed?.kind === "final" ? streamed.timings : null,
        bytes: audio.size,
        type: audio.type,
        status: answer?.status ?? "unreachable",
        audioSeconds: answer?.status === "ok" ? answer.audioSeconds : null,
        providerMs: answer?.status === "ok" ? answer.providerMs : null,
      },
    });
    if (!mounted.current) return;
    const outcome = outcomeOf(answer);
    setPartial("");
    moveTo("idle");
    if (outcome.kind === "text") {
      setNotice(null);
      deliver.current(outcome.text);
    } else {
      setNotice(outcome.message);
    }
  }, [moveTo]);

  const start = useCallback(async () => {
    setNotice(null);
    moveTo("starting");
    const openTimer = window.setTimeout(() => {
      if (phaseRef.current !== "starting") return;
      moveTo("idle");
      setNotice(MICROPHONE_MESSAGES.timeout);
    }, VOICE_LIMITS.microphoneOpenMs);
    setPartial("");
    let firstPartial = true;
    const session = typeof WebSocket === "undefined" ? null : openStream((text) => {
      if (!mounted.current || phaseRef.current === "idle") return;
      if (firstPartial && performance.getEntriesByName("voice:start").length > 0) {
        firstPartial = false;
        performance.measure("voice:first-partial", { start: "voice:start" });
      }
      setPartial((shown) => mergePartial(shown, text));
    });
    try {
      const active = await startRecording(
        (value) => {
          if (mounted.current) setLevel(value);
        },
        session ? session.sendPcm : undefined,
      );
      if (!mounted.current || phaseRef.current !== "starting") {
        active.cancel();
        session?.cancel();
        return;
      }
      recording.current = active;
      stream.current = session;
      performance.mark("voice:start");
      moveTo("recording");
      const endsAt = performance.now() + VOICE_LIMITS.maxRecordingSeconds * 1_000;
      deadline.current = window.setInterval(() => {
        if (performance.now() >= endsAt) void stop();
      }, 250);
    } catch (error) {
      session?.cancel();
      // A refusal that arrives after the viewer gave up, or after the open timed out, stays quiet.
      if (phaseRef.current !== "starting") return;
      moveTo("idle");
      setLevel(0);
      setNotice(MICROPHONE_MESSAGES[error instanceof MicrophoneError ? error.failure : "unknown"]);
    } finally {
      window.clearTimeout(openTimer);
    }
  }, [moveTo, stop]);

  const press = useCallback(() => {
    const action = pressAction(phaseRef.current);
    if (action === "start") void start();
    if (action === "stop") void stop();
    if (action === "cancel") moveTo("idle");
  }, [start, stop, moveTo]);

  /**
   * Press and hold, for screens where speaking is the primary way in: `start`
   * opens the microphone if it is closed, `end` stops a recording or gives up
   * on one still opening.
   *
   * Both read the live phase rather than the rendered one. A tap short enough
   * to beat a re-render would otherwise leave the microphone open, and an
   * `end` that arrived twice (a release, then the pointer capture being
   * given back) would read as a second press and start recording again.
   */
  const hold = useMemo(
    () => ({
      start: () => {
        if (pressAction(phaseRef.current) === "start") void start();
      },
      end: () => {
        const action = pressAction(phaseRef.current);
        if (action === "stop") void stop();
        if (action === "cancel") moveTo("idle");
      },
    }),
    [start, stop, moveTo],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearDeadline();
      recording.current?.cancel();
      recording.current = null;
      stream.current?.cancel();
      stream.current = null;
    };
  }, []);

  return { phase, level, notice, partial, press, hold };
}
