import { createLogger } from "@common/marshal-logger";
import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeService } from "@/services/transcribe";

import { encodeWav } from "../editor/utils/wav-encoder";

const log = createLogger("useAudioRecorder");

/** Speech transcription works best with 16kHz mono PCM. */
const TARGET_SAMPLE_RATE = 16000;

export type RecorderStatus = "idle" | "recording" | "transcribing";

export interface UseAudioRecorder {
  status: RecorderStatus;
  error: string | null;
  /** True while recording or transcribing. */
  busy: boolean;
  /** Epoch ms when the active recording began; null unless recording. */
  startedAt: number | null;
  /**
   * Live analyser node tapping the microphone stream, for waveform rendering.
   * Null unless recording (or when the browser can't build one). It only
   * observes the stream — it's never connected to an output — so there is no
   * playback or feedback.
   */
  analyser: AnalyserNode | null;
  /** Begin capturing from the default microphone. */
  start: () => Promise<void>;
  /** Stop, transcribe, and return the recognized text (empty for silence). */
  stopAndTranscribe: () => Promise<string>;
  /** Abort recording without transcribing. */
  cancel: () => void;
}

/**
 * Microphone capture + transcription. Records via MediaRecorder, decodes and
 * resamples to 16kHz mono PCM WAV in the renderer (the format the
 * `transcribe:audio` IPC contract expects), then sends it to the main process.
 */
export function useAudioRecorder(): UseAudioRecorder {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setAnalyser(null);
    setStartedAt(null);
  }, []);

  // Stop any live capture on unmount.
  useEffect(() => cleanupStream, [cleanupStream]);

  const start = useCallback(async () => {
    setError(null);
    if (recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      // Tap the same stream for the live waveform. Best-effort: an AudioContext
      // failure must not stop recording, so the visualization just goes flat.
      try {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const node = audioContext.createAnalyser();
        node.fftSize = 1024;
        source.connect(node);
        audioContextRef.current = audioContext;
        setAnalyser(node);
      } catch (visErr) {
        audioContextRef.current = null;
        setAnalyser(null);
        log.warn(
          "Waveform analyser unavailable:",
          visErr instanceof Error ? visErr.message : visErr,
        );
      }
      recorderRef.current = recorder;
      recorder.start();
      setStartedAt(Date.now());
      setStatus("recording");
    } catch (err) {
      cleanupStream();
      setStatus("idle");
      const message =
        err instanceof Error ? err.message : "Could not access the microphone";
      setError(message);
      log.error("Failed to start recording:", message);
      throw err;
    }
  }, [cleanupStream]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    cleanupStream();
    setStatus("idle");
  }, [cleanupStream]);

  const stopAndTranscribe = useCallback(async (): Promise<string> => {
    const recorder = recorderRef.current;
    if (!recorder) return "";

    const recordedBlob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      if (recorder.state !== "inactive") recorder.stop();
      else resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
    });
    cleanupStream();

    setStatus("transcribing");
    try {
      const wav = await blobToWav(recordedBlob);
      const text = await transcribeService.transcribe(wav);
      setStatus("idle");
      return text;
    } catch (err) {
      setStatus("idle");
      const message = err instanceof Error ? err.message : "Transcription failed";
      setError(message);
      log.error("Transcription failed:", message);
      throw err;
    }
  }, [cleanupStream]);

  return {
    status,
    error,
    busy: status !== "idle",
    startedAt,
    analyser,
    start,
    stopAndTranscribe,
    cancel,
  };
}

/** Decode an arbitrary recorded blob, downmix to mono, resample to 16kHz, encode WAV. */
async function blobToWav(blob: Blob): Promise<Uint8Array> {
  const arrayBuffer = await blob.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error("No audio was captured. Try recording again.");
  }

  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close();
  }

  const frameCount = Math.ceil((decoded.duration || 0) * TARGET_SAMPLE_RATE);
  if (frameCount <= 0) {
    throw new Error("Recording was empty. Try again.");
  }

  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}
