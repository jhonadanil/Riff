import { useRef } from "react";
import { create } from "zustand";
import { useProject, type AutoParam, type AutoPoint, type Track } from "@/store/project";
import { TRACK_H } from "./ClipView";

/** Qué envolvente se está viendo/editando en cada pista (solo de la interfaz, no se guarda). */
export const useAutomationUi = create<{ shown: Record<string, AutoParam | undefined> }>(() => ({ shown: {} }));

export function showAutomation(trackId: string, param: AutoParam | undefined) {
  useAutomationUi.setState((s) => ({ shown: { ...s.shown, [trackId]: param } }));
}

const LABEL: Record<AutoParam, string> = { volume: "Volumen", pan: "Pan" };
const toNorm = (param: AutoParam, v: number) => (param === "pan" ? (v + 1) / 2 : v);
const fromNorm = (param: AutoParam, n: number) => (param === "pan" ? n * 2 - 1 : n);
const fixed = (param: AutoParam, v: number) => (param === "pan" ? Math.max(-1, Math.min(1, v)) : Math.max(0, Math.min(1, v)));
const sorted = (pts: AutoPoint[]) => [...pts].sort((a, b) => a.t - b.t);

/**
 * Envolvente de volumen o pan dibujada sobre la pista.
 * Clic en vacío = punto nuevo · arrastrar un punto = moverlo · doble clic o clic derecho = quitarlo.
 * Con puntos, la envolvente manda sobre el fader mientras suena (y al exportar).
 */
export function AutomationLane({ track, param, pxPerSec }: { track: Track; param: AutoParam; pxPerSec: number }) {
  const points = track.automation?.[param] ?? [];
  const svg = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  const base = param === "pan" ? track.pan : track.volume;
  const H = TRACK_H;

  const toPoint = (e: React.PointerEvent): AutoPoint => {
    const r = svg.current!.getBoundingClientRect();
    const n = 1 - (e.clientY - r.top) / r.height;
    return { t: Math.max(0, (e.clientX - r.left) / pxPerSec), v: fixed(param, fromNorm(param, n)) };
  };
  const set = (pts: AutoPoint[]) => useProject.getState().setAutomation(track.id, param, pts);

  const move = (e: React.PointerEvent) => {
    const i = dragIndex.current;
    if (i === null) return;
    const next = points.slice();
    next[i] = toPoint(e);
    set(next);
  };

  const y = (v: number) => (1 - toNorm(param, v)) * H;
  const line = points.length
    ? [`0,${y(points[0].v)}`, ...points.map((p) => `${p.t * pxPerSec},${y(p.v)}`), `100000,${y(points[points.length - 1].v)}`].join(" ")
    : `0,${y(base)} 100000,${y(base)}`;

  return (
    <svg
      ref={svg}
      className="absolute inset-0 z-[8] h-full w-full cursor-crosshair bg-background/40"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = toPoint(e);
        useProject.getState().checkpoint();
        const next = sorted([...points, p]);
        dragIndex.current = next.indexOf(p);
        set(next);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        // Al soltar se reordenan por tiempo por si se ha cruzado un punto con otro
        if (dragIndex.current !== null) set(sorted(points));
        dragIndex.current = null;
      }}
      onContextMenu={(e) => e.stopPropagation()}
      role="group"
      aria-label={`Automatización de ${LABEL[param]} de ${track.name}`}
    >
      <text x={8} y={14} className="pointer-events-none fill-muted-foreground text-[10px]">
        Automatización · {LABEL[param]}
        {track.autoOff ? " (desactivada)" : points.length ? "" : " · clic para añadir puntos"}
      </text>
      <polyline points={line} fill="none" stroke="var(--foreground)" strokeWidth={1.5} opacity={track.autoOff || !points.length ? 0.35 : 0.9} strokeDasharray={points.length ? undefined : "4 3"} />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.t * pxPerSec}
          cy={y(p.v)}
          r={5}
          className="cursor-grab fill-background stroke-foreground"
          strokeWidth={1.5}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            svg.current!.setPointerCapture(e.pointerId);
            useProject.getState().checkpoint();
            dragIndex.current = i;
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            useProject.getState().checkpoint();
            set(points.filter((_, k) => k !== i));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            useProject.getState().checkpoint();
            set(points.filter((_, k) => k !== i));
          }}
        />
      ))}
    </svg>
  );
}
