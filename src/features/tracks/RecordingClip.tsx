import { useEffect, useRef, useState } from "react";
import { position } from "@/audio/engine";
import { LIVE_PEAKS_PER_SEC, livePeaks, useRecorder } from "@/audio/recorder";

const REC_COLOR = "var(--rec)";

/** La toma que se está grabando en esta pista: crece con el cursor y dibuja la onda en vivo. */
export function RecordingClip({ trackId, pxPerSec }: { trackId: string; pxPerSec: number }) {
  const active = useRecorder((r) => (r.phase === "recording" || r.phase === "finishing") && r.trackIds.includes(trackId));
  const start = useRecorder((r) => r.start);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const box = boxRef.current;
      const canvas = canvasRef.current;
      if (box && canvas) {
        const width = Math.max(2, (position() - start) * pxPerSec);
        box.style.width = `${width}px`;
        drawPeaks(canvas, width, pxPerSec);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, start, pxPerSec]);

  if (!active) return null;
  return (
    <div
      ref={boxRef}
      className="pointer-events-none absolute inset-y-1 z-[5] flex flex-col overflow-hidden rounded-md border"
      style={{ left: start * pxPerSec, borderColor: REC_COLOR, background: `color-mix(in oklch, ${REC_COLOR} 16%, transparent)` }}
      aria-label="Grabando"
    >
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap"
        style={{ background: `color-mix(in oklch, ${REC_COLOR} 32%, transparent)` }}
      >
        <span className="size-1.5 rounded-full" style={{ background: REC_COLOR }} />
        Grabando
      </span>
      <canvas ref={canvasRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}

function drawPeaks(canvas: HTMLCanvasElement, width: number, pxPerSec: number) {
  const dpr = window.devicePixelRatio || 1;
  const h = canvas.clientHeight;
  const w = Math.ceil(width);
  if (canvas.width !== Math.ceil(w * dpr) || canvas.height !== Math.ceil(h * dpr)) {
    canvas.width = Math.ceil(w * dpr);
    canvas.height = Math.ceil(h * dpr);
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = REC_COLOR;
  const pxPerPeak = pxPerSec / LIVE_PEAKS_PER_SEC;
  const mid = h / 2;
  // Una barra por píxel con el pico más alto que cae en él
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x / pxPerPeak);
    const b = Math.min(livePeaks.length, Math.max(a + 1, Math.floor((x + 1) / pxPerPeak)));
    let v = 0;
    for (let i = a; i < b; i++) if (livePeaks[i] > v) v = livePeaks[i];
    if (!v) continue;
    const half = Math.max(0.5, Math.min(1, v) * mid);
    g.fillRect(x, mid - half, 1, half * 2);
  }
}

/** Mientras se graba, hasta dónde llega la toma (s), actualizado cada medio segundo. */
export function useRecordingEnd() {
  const recording = useRecorder((r) => r.phase === "recording");
  const [end, setEnd] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setEnd(position()), 500);
    return () => clearInterval(id);
  }, [recording]);
  return recording ? end : 0;
}
