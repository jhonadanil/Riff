import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Scissors, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getPeaks, position } from "@/audio/engine";
import { snapTime, useProject, type Clip } from "@/store/project";
import { cn } from "@/lib/utils";

export const TRACK_H = 80; // alto de una pista (h-20)
const MIN_CLIP_SEC = 0.05;
const HANDLE_PX = 6;

type Mode = "move" | "trim-l" | "trim-r";
type Props = { clip: Clip; color: string; pxPerSec: number };

export function ClipView({ clip, color, pxPerSec }: Props) {
  const selected = useProject((s) => s.selectedClipId === clip.id);
  const waveRef = useRef<HTMLDivElement>(null);
  // Vista previa mientras se arrastra (se confirma en el store al soltar)
  const [preview, setPreview] = useState<{ clip: Clip; rows: number } | null>(null);
  const drag = useRef<{ mode: Mode; x: number; y: number; orig: Clip } | null>(null);

  // La forma de onda es la del audio original completo; el recorte la "enmarca"
  useEffect(() => {
    const peaks = getPeaks(clip.bufferId);
    if (!waveRef.current || !peaks) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      peaks: [peaks],
      duration: clip.sourceDuration,
      height: "auto",
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      normalize: true,
    });
    return () => ws.destroy();
  }, [clip.bufferId, clip.sourceDuration, color]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    useProject.getState().selectClip(clip.id);
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const width = e.currentTarget.getBoundingClientRect().width;
    const mode: Mode = x <= HANDLE_PX ? "trim-l" : x >= width - HANDLE_PX ? "trim-r" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, orig: clip };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x) / pxPerSec;
    const o = d.orig;
    const end = o.start + o.duration;
    const sourceStart = o.start - o.offset; // dónde caería el inicio del audio original

    if (d.mode === "move") {
      const { tracks } = useProject.getState();
      const idx = tracks.findIndex((t) => t.id === o.trackId);
      const target = Math.min(tracks.length - 1, Math.max(0, idx + Math.round((e.clientY - d.y) / TRACK_H)));
      const start = Math.max(0, snapTime(o.start + dt));
      setPreview({ clip: { ...o, start, trackId: tracks[target].id }, rows: target - idx });
    } else if (d.mode === "trim-l") {
      const start = Math.min(end - MIN_CLIP_SEC, Math.max(sourceStart, 0, snapTime(o.start + dt)));
      setPreview({ clip: { ...o, start, offset: o.offset + (start - o.start), duration: end - start }, rows: 0 });
    } else {
      const newEnd = Math.max(o.start + MIN_CLIP_SEC, Math.min(sourceStart + o.sourceDuration, snapTime(end + dt)));
      setPreview({ clip: { ...o, duration: newEnd - o.start }, rows: 0 });
    }
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    const p = preview?.clip;
    const o = drag.current.orig;
    if (p && (p.start !== o.start || p.trackId !== o.trackId || p.duration !== o.duration)) {
      const { checkpoint, updateClip } = useProject.getState();
      checkpoint();
      updateClip(clip.id, { start: p.start, trackId: p.trackId, offset: p.offset, duration: p.duration });
    }
    drag.current = null;
    setPreview(null);
  };

  const c = preview?.clip ?? clip;
  const mode = drag.current?.mode;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group absolute inset-y-1 flex flex-col overflow-hidden rounded-md border select-none",
            mode === "move" ? "cursor-grabbing" : "cursor-grab",
            selected && "ring-2 ring-foreground/70",
            preview && "z-[6] shadow-lg",
          )}
          style={{
            left: c.start * pxPerSec,
            width: Math.max(2, c.duration * pxPerSec),
            transform: preview?.rows ? `translateY(${preview.rows * TRACK_H}px)` : undefined,
            borderColor: color,
            background: `color-mix(in oklch, ${color} 18%, transparent)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={() => useProject.getState().selectClip(clip.id)}
        >
          <span
            className="relative z-[1] truncate px-1.5 py-0.5 text-[11px] font-medium leading-none"
            style={{ background: `color-mix(in oklch, ${color} 35%, transparent)` }}
          >
            {clip.name}
          </span>
          <div className="relative min-h-0 flex-1">
            <div
              ref={waveRef}
              className="absolute inset-y-0 opacity-90"
              style={{ left: -c.offset * pxPerSec, width: c.sourceDuration * pxPerSec }}
            />
          </div>
          {/* Asas de recorte */}
          <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100" style={{ background: color }} />
          <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100" style={{ background: color }} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => useProject.getState().splitAt(position())}>
          <Scissors />
          Dividir en el cursor
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => useProject.getState().removeClip(clip.id)}>
          <Trash2 />
          Eliminar clip
          <ContextMenuShortcut>Supr</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
