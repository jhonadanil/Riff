import { useEffect, useRef } from "react";
import { inputLevel } from "@/audio/input";
import { cn } from "@/lib/utils";

const FLOOR_DB = -60;
/** Por encima de esto se considera que la señal satura. */
const CLIP_LEVEL = 0.989; // ≈ −0.1 dBFS
const CLIP_HOLD_MS = 1500;
const PEAK_HOLD_MS = 800;

/** Posición 0..1 en el medidor para un nivel lineal (escala en dB). */
const toPos = (level: number) => {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
};

/**
 * Medidor horizontal del nivel de entrada: barra de RMS, marca de pico
 * y piloto de saturación. Se pinta cada frame sin re-renderizar React.
 */
export function InputMeter({
  className,
  showScale = false,
  channel,
}: {
  className?: string;
  showScale?: boolean;
  /** Medir una entrada concreta del dispositivo (0 = entrada 1, 1 = entrada 2) en vez de la señal elegida. */
  channel?: 0 | 1;
}) {
  const rmsRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let held = 0;
    let heldAt = 0;
    let clipAt = -Infinity;
    const tick = (now: number) => {
      const { peak, rms } = inputLevel(channel);
      if (peak >= held || now - heldAt > PEAK_HOLD_MS) {
        held = peak;
        heldAt = now;
      }
      if (peak >= CLIP_LEVEL) clipAt = now;
      if (rmsRef.current) rmsRef.current.style.clipPath = `inset(0 ${(1 - toPos(rms)) * 100}% 0 0)`;
      if (peakRef.current) {
        const p = toPos(held);
        peakRef.current.style.left = `calc(${p * 100}% - 2px)`;
        peakRef.current.style.opacity = p > 0 ? "1" : "0";
      }
      if (clipRef.current) clipRef.current.dataset.on = String(now - clipAt < CLIP_HOLD_MS);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [channel]);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Nivel de entrada">
          <div
            ref={rmsRef}
            className="absolute inset-0 bg-linear-to-r from-ok from-70% via-warn via-88% to-rec"
            style={{ clipPath: "inset(0 100% 0 0)" }}
          />
          <div ref={peakRef} className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ opacity: 0 }} />
        </div>
        <div
          ref={clipRef}
          data-on="false"
          className="size-2 shrink-0 rounded-full bg-muted transition-colors data-[on=true]:bg-rec"
          title="Saturación"
        />
      </div>
      {showScale && (
        <div className="relative mr-3.5 h-3 text-[10px] text-muted-foreground tabular-nums">
          {[-60, -48, -36, -24, -12, -6, 0].map((db) => (
            <span
              key={db}
              className="absolute -translate-x-1/2 last:-translate-x-full first:translate-x-0"
              style={{ left: `${toPos(10 ** (db / 20)) * 100}%` }}
            >
              {db}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
