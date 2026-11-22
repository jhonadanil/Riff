import { useEffect, useRef, useState } from "react";
import { meterOf } from "@/audio/engine";
import { cn } from "@/lib/utils";

const FLOOR_DB = -60;
/** Posición (0..1) de un pico lineal en la escala del medidor (−60 dB … 0 dB). */
const level = (peak: number) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(peak, 1e-6)) - FLOOR_DB) / -FLOOR_DB));

/**
 * Medidor estéreo (dos barras) del sonido que sale de una pista, un bus o el master ("master").
 * Cae poco a poco, marca el pico máximo y enciende un piloto rojo si se pasa de 0 dB;
 * el piloto se queda encendido hasta que se hace clic en él.
 */
export function LevelMeter({ id, label }: { id: string; label: string }) {
  const bars = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const holds = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const [clipped, setClipped] = useState(false);
  const clippedRef = useRef(false);
  clippedRef.current = clipped;
  const reset = useRef(false);

  useEffect(() => {
    const shown = [0, 0];
    const held = [0, 0];
    const heldAt = [0, 0];
    let raf = 0;
    const tick = (now: number) => {
      const peaks = meterOf(id)?.read() ?? [0, 0];
      for (let i = 0; i < 2; i++) {
        const l = level(peaks[i]);
        shown[i] = Math.max(l, shown[i] - 0.02);
        if (l >= held[i] || now - heldAt[i] > 1200) {
          held[i] = l;
          heldAt[i] = now;
        }
        const bar = bars[i].current;
        const hold = holds[i].current;
        if (bar) {
          bar.style.height = `${shown[i] * 100}%`;
          bar.style.background = shown[i] > 0.97 ? "var(--rec)" : shown[i] > 0.85 ? "var(--warn)" : "var(--ok)";
        }
        if (hold) {
          hold.style.bottom = `${held[i] * 100}%`;
          hold.style.opacity = held[i] > 0.02 ? "0.8" : "0";
        }
        if (peaks[i] >= 1 && !clippedRef.current) setClipped(true);
      }
      if (reset.current) {
        reset.current = false;
        held[0] = held[1] = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="flex h-full flex-col items-center gap-1" role="meter" aria-label={`Nivel de ${label}`}>
      <button
        type="button"
        className={cn("size-2 shrink-0 rounded-full", clipped ? "bg-rec" : "bg-muted")}
        title={clipped ? "Se ha pasado de 0 dB: clic para borrar" : "Sin saturación"}
        aria-label="Borrar indicador de saturación"
        onClick={() => {
          setClipped(false);
          reset.current = true;
        }}
      />
      <div className="flex min-h-0 flex-1 gap-0.5">
        {bars.map((ref, i) => (
          <div key={i} className="relative h-full w-1.5 overflow-hidden rounded-full bg-muted">
            <div ref={ref} className="absolute inset-x-0 bottom-0" />
            <div ref={holds[i]} className="absolute inset-x-0 h-px bg-foreground" />
          </div>
        ))}
      </div>
    </div>
  );
}
