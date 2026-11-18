import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getPeaks } from "@/audio/engine";
import { useProject, type Clip } from "@/store/project";

type Props = { clip: Clip; color: string; pxPerSec: number };

export function ClipView({ clip, color, pxPerSec }: Props) {
  const { updateClip, removeClip } = useProject();
  const waveRef = useRef<HTMLDivElement>(null);
  // Desplazamiento temporal mientras se arrastra (se confirma al soltar)
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);

  useEffect(() => {
    const peaks = getPeaks(clip.bufferId);
    if (!waveRef.current || !peaks) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      peaks: [peaks],
      duration: clip.duration,
      height: "auto",
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      normalize: true,
      barWidth: 0,
    });
    return () => ws.destroy();
  }, [clip.bufferId, clip.duration, color]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: clip.start };
    setDragOffset(0);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const delta = (e.clientX - drag.current.x) / pxPerSec;
    setDragOffset(Math.max(-drag.current.start, delta));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    if (dragOffset) updateClip(clip.id, { start: drag.current.start + dragOffset });
    drag.current = null;
    setDragOffset(null);
  };

  const start = clip.start + (dragOffset ?? 0);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="absolute inset-y-1 flex cursor-grab flex-col overflow-hidden rounded-md border select-none active:cursor-grabbing"
          style={{
            left: start * pxPerSec,
            width: Math.max(2, clip.duration * pxPerSec),
            borderColor: color,
            background: `color-mix(in oklch, ${color} 18%, transparent)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className="truncate px-1.5 py-0.5 text-[11px] font-medium leading-none"
            style={{ background: `color-mix(in oklch, ${color} 35%, transparent)` }}
          >
            {clip.name}
          </span>
          <div ref={waveRef} className="min-h-0 flex-1 opacity-90" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={() => removeClip(clip.id)}>
          <Trash2 />
          Eliminar clip
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
