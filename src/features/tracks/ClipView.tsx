import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { create } from "zustand";
import { Copy, CopyPlus, Gauge, Music2, Scissors, Trash2, Waves } from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { clipPeak, getPeaks, position } from "@/audio/engine";
import { snapTime, useProject, type Clip, type MidiNote } from "@/store/project";
import { cn } from "@/lib/utils";

export const TRACK_H = 80; // alto de una pista (h-20)
const MIN_CLIP_SEC = 0.05;
const HANDLE_PX = 6;

type Mode = "move" | "trim-l" | "trim-r" | "fade-in" | "fade-out";
type Props = { clip: Clip; color: string; pxPerSec: number };

/** Mover varios clips a la vez: el que se arrastra avisa aquí y los demás seleccionados lo siguen. */
const useGroupDrag = create<{ drag: { ids: string[]; dt: number; rows: number } | null }>(() => ({ drag: null }));

const GAINS_DB = [-12, -6, -3, 0, 3, 6];
const dbToGain = (db: number) => 10 ** (db / 20);
const gainToDb = (g: number) => 20 * Math.log10(g);

/** Cruza los clips de la misma pista que se solapan con el dado: el anterior baja mientras el siguiente sube. */
function crossfadeOverlaps(clipId: string) {
  const { clips, updateClips } = useProject.getState();
  const me = clips.find((c) => c.id === clipId);
  if (!me) return;
  const fades = new Map<string, { fadeIn?: number; fadeOut?: number }>();
  for (const other of clips) {
    if (other.id === me.id || other.trackId !== me.trackId) continue;
    const [first, second] = me.start <= other.start ? [me, other] : [other, me];
    const overlap = Math.min(first.start + first.duration, second.start + second.duration) - second.start;
    if (overlap <= 0.001) continue;
    fades.set(first.id, { ...fades.get(first.id), fadeOut: overlap });
    fades.set(second.id, { ...fades.get(second.id), fadeIn: overlap });
  }
  if (!fades.size) {
    toast.info("Este clip no se solapa con ningún otro", { description: "Arrastra uno sobre otro para cruzarlos." });
    return;
  }
  updateClips([...fades.keys()], (c) => fades.get(c.id)!);
}

export function ClipView({ clip, color, pxPerSec }: Props) {
  const selected = useProject((s) => s.selectedClipIds.includes(clip.id));
  const grouped = useGroupDrag((s) => (s.drag?.ids.includes(clip.id) ? s.drag : null));
  const waveRef = useRef<HTMLDivElement>(null);
  // Vista previa mientras se arrastra (se confirma en el store al soltar)
  const [preview, setPreview] = useState<Clip | null>(null);
  const drag = useRef<{ mode: Mode; x: number; y: number; orig: Clip; additive: boolean } | null>(null);

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
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    useProject.getState().selectClip(clip.id, additive);
    if (additive) return; // solo añade o quita de la selección
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const fade = (e.target as HTMLElement).dataset.fade;
    const mode: Mode = fade === "in" ? "fade-in" : fade === "out" ? "fade-out" : x <= HANDLE_PX ? "trim-l" : x >= box.width - HANDLE_PX ? "trim-r" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, orig: clip, additive };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x) / pxPerSec;
    const o = d.orig;
    const end = o.start + o.duration;
    const sourceStart = o.start - o.offset; // dónde caería el inicio del audio original

    if (d.mode === "move") {
      const st = useProject.getState();
      const ids = st.selectedClipIds.includes(o.id) ? st.selectedClipIds : [o.id];
      const group = st.clips.filter((c) => ids.includes(c.id));
      const rowsOf = group.map((c) => st.tracks.findIndex((t) => t.id === c.trackId));
      const dtSnapped = Math.max(-Math.min(...group.map((c) => c.start)), snapTime(o.start + dt) - o.start);
      const rows = Math.min(
        st.tracks.length - 1 - Math.max(...rowsOf),
        Math.max(-Math.min(...rowsOf), Math.round((e.clientY - d.y) / TRACK_H)),
      );
      useGroupDrag.setState({ drag: { ids, dt: dtSnapped, rows } });
    } else if (d.mode === "trim-l") {
      const start = Math.min(end - MIN_CLIP_SEC, Math.max(o.midi ? 0 : Math.max(sourceStart, 0), snapTime(o.start + dt)));
      const cut = start - o.start;
      setPreview({
        ...o,
        start,
        offset: o.offset + cut,
        duration: end - start,
        fadeIn: Math.min(o.fadeIn ?? 0, end - start),
      });
    } else if (d.mode === "trim-r") {
      const limit = o.midi ? Infinity : sourceStart + o.sourceDuration;
      const newEnd = Math.max(o.start + MIN_CLIP_SEC, Math.min(limit, snapTime(end + dt)));
      setPreview({ ...o, duration: newEnd - o.start, fadeOut: Math.min(o.fadeOut ?? 0, newEnd - o.start) });
    } else if (d.mode === "fade-in") {
      setPreview({ ...o, fadeIn: Math.max(0, Math.min(o.duration - (o.fadeOut ?? 0), (o.fadeIn ?? 0) + dt)) });
    } else {
      setPreview({ ...o, fadeOut: Math.max(0, Math.min(o.duration - (o.fadeIn ?? 0), (o.fadeOut ?? 0) - dt)) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const st = useProject.getState();

    if (d.mode === "move") {
      const g = useGroupDrag.getState().drag;
      useGroupDrag.setState({ drag: null });
      if (g && (g.dt !== 0 || g.rows !== 0)) {
        st.updateClips(g.ids, (c) => {
          const row = st.tracks.findIndex((t) => t.id === c.trackId);
          return { start: Math.max(0, c.start + g.dt), trackId: st.tracks[row + g.rows].id };
        });
      } else if (st.selectedClipIds.length > 1) {
        // Un clic sin arrastrar sobre un grupo se queda solo con ese clip
        useProject.setState({ selectedClipIds: [clip.id], selectedClipId: clip.id });
      }
      return;
    }

    const p = preview;
    setPreview(null);
    const o = d.orig;
    if (p && (p.start !== o.start || p.duration !== o.duration || p.fadeIn !== o.fadeIn || p.fadeOut !== o.fadeOut)) {
      st.checkpoint();
      st.updateClip(clip.id, {
        start: p.start,
        offset: p.offset,
        duration: p.duration,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        // Un clip MIDI puede crecer más allá de lo que tenía
        ...(o.midi && { sourceDuration: Math.max(o.sourceDuration, p.offset + p.duration) }),
      });
    }
  };

  const c = preview ?? (grouped ? { ...clip, start: clip.start + grouped.dt } : clip);
  const rows = grouped?.rows ?? 0;
  const moving = grouped !== null && (grouped.dt !== 0 || grouped.rows !== 0);
  const widthPx = Math.max(2, c.duration * pxPerSec);
  const fadeInPx = (c.fadeIn ?? 0) * pxPerSec;
  const fadeOutPx = (c.fadeOut ?? 0) * pxPerSec;
  const gainDb = c.gain && c.gain !== 1 ? gainToDb(c.gain) : 0;

  const setGain = (gain: number) => useProject.getState().updateClips(selectedOrThis(clip.id), () => ({ gain: gain === 1 ? undefined : gain }));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group absolute inset-y-1 flex flex-col overflow-hidden rounded-md border select-none",
            moving ? "cursor-grabbing" : "cursor-grab",
            selected && "ring-2 ring-foreground/70",
            (preview || moving) && "z-[6] shadow-lg",
          )}
          style={{
            left: c.start * pxPerSec,
            width: widthPx,
            transform: rows ? `translateY(${rows * TRACK_H}px)` : undefined,
            borderColor: color,
            background: `color-mix(in oklch, ${color} 18%, transparent)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            if (!clip.midi) return;
            e.stopPropagation();
            useProject.getState().openPianoRoll(clip.id);
          }}
          onContextMenu={(e) => {
            e.stopPropagation();
            useProject.getState().selectClip(clip.id);
          }}
        >
          <span
            className="relative z-[1] truncate px-1.5 py-0.5 text-[11px] font-medium leading-none"
            style={{ background: `color-mix(in oklch, ${color} 35%, transparent)` }}
          >
            {clip.name}
            {gainDb !== 0 && <span className="ml-1 opacity-70">{`${gainDb > 0 ? "+" : "−"}${Math.abs(gainDb).toFixed(1)} dB`}</span>}
          </span>
          <div className="relative min-h-0 flex-1">
            {clip.midi ? (
              <MidiNotes
                notes={clip.midi}
                color={color}
                duration={c.sourceDuration}
                style={{ left: -c.offset * pxPerSec, width: c.sourceDuration * pxPerSec }}
              />
            ) : (
              <div
                ref={waveRef}
                className="absolute inset-y-0 opacity-90"
                style={{ left: -c.offset * pxPerSec, width: c.sourceDuration * pxPerSec }}
              />
            )}
          </div>

          {/* Fundidos: la zona sombreada es lo que se atenúa */}
          {(fadeInPx > 0 || fadeOutPx > 0) && (
            <svg
              className="pointer-events-none absolute inset-0 z-[1]"
              width="100%"
              height="100%"
              viewBox={`0 0 ${widthPx} 100`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {fadeInPx > 0 && <polygon points={`0,0 ${fadeInPx},0 0,100`} fill="var(--background)" opacity="0.6" />}
              {fadeOutPx > 0 && <polygon points={`${widthPx - fadeOutPx},0 ${widthPx},0 ${widthPx},100`} fill="var(--background)" opacity="0.6" />}
            </svg>
          )}
          <span
            data-fade="in"
            className={cn(
              "absolute top-0 z-[2] size-2.5 cursor-ew-resize rounded-br-sm opacity-0 transition-opacity group-hover:opacity-100",
              selected && "opacity-100",
            )}
            style={{ left: fadeInPx, background: color }}
            title="Arrastra para hacer un fundido de entrada"
          />
          <span
            data-fade="out"
            className={cn(
              "absolute top-0 z-[2] size-2.5 cursor-ew-resize rounded-bl-sm opacity-0 transition-opacity group-hover:opacity-100",
              selected && "opacity-100",
            )}
            style={{ right: fadeOutPx, background: color }}
            title="Arrastra para hacer un fundido de salida"
          />

          {/* Asas de recorte */}
          <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100" style={{ background: color }} />
          <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100" style={{ background: color }} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <ContextMenuItem onSelect={() => useProject.getState().splitAt(position())}>
          <Scissors />
          Dividir en el cursor
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => useProject.getState().copySelection()}>
          <Copy />
          Copiar
          <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => useProject.getState().duplicateSelection()}>
          <CopyPlus />
          Duplicar
          <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
        </ContextMenuItem>
        {clip.midi && (
          <ContextMenuItem onSelect={() => useProject.getState().openPianoRoll(clip.id)}>
            <Music2 />
            Editar notas…
          </ContextMenuItem>
        )}
        {!clip.midi && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Gauge />
                Ganancia
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuRadioGroup value={String(Math.round(gainDb))} onValueChange={(v) => setGain(dbToGain(Number(v)))}>
                  {GAINS_DB.map((db) => (
                    <ContextMenuRadioItem key={db} value={String(db)}>
                      {db > 0 ? `+${db}` : db < 0 ? `−${-db}` : "0"} dB
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              onSelect={() => {
                const peak = clipPeak(clip);
                if (!peak) return toast.info("Este clip es silencio: no se puede normalizar");
                // Deja el pico en −1 dB
                useProject.getState().updateClips(selectedOrThis(clip.id), (k) => {
                  const p = clipPeak(k);
                  return p ? { gain: dbToGain(-1) / p } : {};
                });
              }}
            >
              <Waves />
              Normalizar (pico a −1 dB)
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => crossfadeOverlaps(clip.id)}>Fundido cruzado con los solapados</ContextMenuItem>
            <ContextMenuItem
              disabled={!clip.fadeIn && !clip.fadeOut}
              onSelect={() => useProject.getState().updateClips(selectedOrThis(clip.id), () => ({ fadeIn: undefined, fadeOut: undefined }))}
            >
              Quitar fundidos
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => useProject.getState().removeClips(selectedOrThis(clip.id))}>
          <Trash2 />
          Eliminar
          <ContextMenuShortcut>Supr</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Los clips seleccionados (o solo este, si no está dentro de la selección). */
function selectedOrThis(id: string) {
  const ids = useProject.getState().selectedClipIds;
  return ids.includes(id) ? ids : [id];
}

/** Las notas de un clip MIDI dibujadas como barras (más arriba = nota más aguda). */
function MidiNotes({ notes, color, duration, style }: { notes: MidiNote[]; color: string; duration: number; style: React.CSSProperties }) {
  if (!notes.length) return null;
  const lo = Math.min(...notes.map((n) => n.n));
  const hi = Math.max(...notes.map((n) => n.n));
  // Un mínimo de filas para que pocas notas distintas no queden enormes
  const rows = Math.max(hi - lo + 1, 8);
  const top = hi + (rows - (hi - lo + 1)) / 2;
  return (
    <svg
      className="absolute inset-y-0"
      style={style}
      viewBox={`0 0 ${duration} ${rows}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {notes.map((n, i) => (
        <rect
          key={i}
          x={n.t}
          y={top - n.n}
          width={Math.max(n.d, duration / 400)}
          height={0.8}
          rx={0.1}
          fill={color}
          opacity={0.35 + (n.v / 127) * 0.65}
        />
      ))}
    </svg>
  );
}
