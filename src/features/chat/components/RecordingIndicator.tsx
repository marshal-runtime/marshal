import { useEffect, useRef, useState } from "react";

import { formatRecordingElapsed } from "./recording-time";

interface RecordingIndicatorProps {
  /**
   * Live analyser tapping the mic stream. Null renders a flat baseline (the
   * timer keeps running), e.g. when the browser couldn't build one.
   */
  analyser: AnalyserNode | null;
  /** Epoch ms when recording began; drives the elapsed timer. */
  startedAt: number;
}

/** Bar geometry for the rolling voice-memo-style waveform (CSS pixels). */
const BAR_WIDTH = 2;
const BAR_GAP = 1;
/** Push a new bar roughly every this-many ms so bars scroll at a natural pace. */
const SAMPLE_INTERVAL_MS = 65;

/**
 * Voice-memo-style recording affordance: a live scrolling waveform driven by
 * the mic analyser plus a counting elapsed timer. Rendered only while a
 * recording is in progress.
 */
export function RecordingIndicator({ analyser, startedAt }: RecordingIndicatorProps) {
  // `now` ticks on an interval; elapsed is derived during render so this stays
  // free of synchronous setState-in-effect.
  const [now, setNow] = useState(() => Date.now());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Draw the rolling waveform from live time-domain samples.
  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      const color = getComputedStyle(canvas).color || "#ef4444";
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssWidth = canvas.clientWidth || 96;
      const cssHeight = canvas.clientHeight || 24;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.scale(dpr, dpr);

      const maxBars = Math.max(1, Math.floor(cssWidth / (BAR_WIDTH + BAR_GAP)));
      const bars: number[] = [];
      const timeData = analyser ? new Uint8Array(analyser.fftSize) : null;
      let lastSample = 0;
      let peak = 0;

      const draw = (frameTime: number) => {
        raf = requestAnimationFrame(draw);

        if (analyser && timeData) {
          analyser.getByteTimeDomainData(timeData);
          // Largest deviation from the 128 midpoint, normalized to 0..1.
          let localPeak = 0;
          for (let i = 0; i < timeData.length; i++) {
            const deviation = Math.abs(timeData[i] - 128) / 128;
            if (deviation > localPeak) localPeak = deviation;
          }
          if (localPeak > peak) peak = localPeak;
        }

        if (frameTime - lastSample >= SAMPLE_INTERVAL_MS) {
          lastSample = frameTime;
          bars.push(peak);
          peak = 0;
          if (bars.length > maxBars) bars.shift();
        }

        ctx.clearRect(0, 0, cssWidth, cssHeight);
        ctx.fillStyle = color;
        const mid = cssHeight / 2;
        // Right-align so fresh samples enter on the right and scroll left.
        const startX = cssWidth - bars.length * (BAR_WIDTH + BAR_GAP);
        for (let i = 0; i < bars.length; i++) {
          const barHeight = Math.max(1.5, bars[i] * (cssHeight - 2));
          const x = startX + i * (BAR_WIDTH + BAR_GAP);
          ctx.fillRect(x, mid - barHeight / 2, BAR_WIDTH, barHeight);
        }
      };

      raf = requestAnimationFrame(draw);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [analyser]);

  const label = formatRecordingElapsed(now - startedAt);

  return (
    <div
      className="flex items-center gap-2 rounded-full bg-destructive/10 px-2.5 py-1"
      data-testid="recording-indicator"
    >
      <canvas ref={canvasRef} className="h-6 w-24 text-destructive" aria-hidden="true" />
      <span
        className="min-w-[3ch] text-xs font-medium tabular-nums text-destructive"
        data-testid="recording-timer"
        role="timer"
        aria-label={`Recording, ${label} elapsed`}
      >
        {label}
      </span>
    </div>
  );
}
