import { useEffect, useRef, useState } from "react";
import { Headphones, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { gridSeconds, snapTime, useProject, type Track } from "@/store/project";
import * as engine from "@/audio/engine";
import { useInput } from "@/audio/input";
import { cn } from "@/lib/utils";
import { ClipView, TRACK_H } from "./ClipView";
import { RecordingClip, useRecordingEnd } from "./RecordingClip";
import { importAudioFiles } from "./importAudio";

const HEADER_W = 248; // ancho de la cabecera de pista
const RULER_H = 28;
const MIN_LENGTH_SEC = engine.EMPTY_SONG_SEC; // la línea de tiempo nunca es más corta que esto
const TAIL_SEC = 30; // espacio libre tras el último clip

export function TrackList() {
  const { tracks, clips, bpm, pxPerSec, loop, loopEnabled, selectTrack, setZoom, addTrack } = useProject();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);

  const recordingEnd = useRecordingEnd();
  const lastEnd = clips.reduce((m, c) => Math.max(m, c.start + c.duration), recordingEnd);
  const lengthSec = Math.max(MIN_LENGTH_SEC, lastEnd + TAIL_SEC);
  const timelineW = lengthSec * pxPerSec;

  /** Convierte la X del ratón (en pantalla) a segundos de la línea de tiempo. */
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W;
    return Math.max(0, x / pxPerSec);
  };

  // La vista sigue al cursor: si salta fuera de la pantalla, o si al reproducir llega al borde derecho
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /** Lleva la vista hasta `t` si no se ve; `margin` = parte del ancho que se deja a la izquierda. */
    const reveal = (t: number, margin: number) => {
      const { pxPerSec: z } = useProject.getState();
      const x = t * z;
      const view = el.clientWidth - HEADER_W;
      if (x < el.scrollLeft || x > el.scrollLeft + view - 8) {
        el.scrollTo({ left: Math.max(0, x - view * margin) });
      }
    };
    const offSeek = engine.onSeek((t) => reveal(t, 0.1));
    let raf = 0;
    const follow = () => {
      if (useProject.getState().isPlaying) reveal(engine.position(), 0.05);
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => {
      offSeek();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Ctrl + rueda = zoom horizontal, manteniendo fijo el punto bajo el ratón
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const { pxPerSec: z, setZoom } = useProject.getState();
      const mouseX = e.clientX - el.getBoundingClientRect().left - HEADER_W;
      const t = (mouseX + el.scrollLeft) / z;
      setZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      const nz = useProject.getState().pxPerSec;
      el.scrollLeft = t * nz - mouseX;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto" aria-label="Línea de tiempo">
      {/* overflow-clip: nada (cursor, clips arrastrados) puede agrandar el área de scroll */}
      <div className="relative min-w-full overflow-clip" style={{ width: HEADER_W + timelineW }}>
        {/* Regla */}
        <div className="sticky top-0 z-20 flex border-b bg-background" style={{ height: RULER_H }}>
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r bg-background px-2"
            style={{ width: HEADER_W }}
          >
            <Button size="icon-xs" variant="ghost" onClick={() => setZoom(pxPerSec / 1.5)} aria-label="Alejar">
              −
            </Button>
            <Button size="icon-xs" variant="ghost" onClick={() => setZoom(pxPerSec * 1.5)} aria-label="Acercar">
              +
            </Button>
            <span className="ml-auto text-[11px] text-muted-foreground">Arrastra en la regla = loop</span>
          </div>
          <Ruler bpm={bpm} pxPerSec={pxPerSec} width={timelineW} timeAt={timeAt} />
        </div>

        {/* Pistas */}
        {tracks.map((t) => (
          <div key={t.id} className="flex border-b" style={{ height: TRACK_H }}>
            <TrackHeader track={t} canDelete={tracks.length > 1} />

            <div
              className={cn(
                "relative flex-1 bg-lane transition-colors",
                dropTrackId === t.id && "bg-foreground/5 outline-2 -outline-offset-4 outline-foreground/30 outline-dashed",
              )}
              onClick={(e) => {
                selectTrack(t.id);
                useProject.getState().selectClip(null);
                engine.seek(timeAt(e.clientX));
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropTrackId(t.id);
              }}
              onDragLeave={() => setDropTrackId((id) => (id === t.id ? null : id))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTrackId(null);
                selectTrack(t.id);
                importAudioFiles(Array.from(e.dataTransfer.files), t.id, snapTime(timeAt(e.clientX)));
              }}
            >
              <GridLines bpm={bpm} pxPerSec={pxPerSec} />
              {clips
                .filter((c) => c.trackId === t.id)
                .map((c) => (
                  <ClipView key={c.id} clip={c} color={t.color} pxPerSec={pxPerSec} />
                ))}
              <RecordingClip trackId={t.id} pxPerSec={pxPerSec} />
            </div>
          </div>
        ))}

        <div className="sticky left-0 flex w-fit items-center gap-4 px-3 py-2">
          <Button variant="ghost" size="sm" onClick={addTrack}>
            <Plus />
            Añadir pista
          </Button>
        </div>

        {/* Región de loop sobre las pistas */}
        {loop && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-0 z-[4] border-x",
              loopEnabled ? "border-foreground/35 bg-foreground/[0.045]" : "border-dashed border-foreground/15",
            )}
            style={{ top: RULER_H, left: HEADER_W + loop.start * pxPerSec, width: (loop.end - loop.start) * pxPerSec }}
          />
        )}

        <Playhead pxPerSec={pxPerSec} scrollRef={scrollRef} />
      </div>
    </div>
  );
}

function TrackHeader({ track: t, canDelete }: { track: Track; canDelete: boolean }) {
  const selected = useProject((s) => s.selectedTrackId === t.id);
  const { updateTrack, selectTrack, removeTrack } = useProject();
  const monitoring = useInput((s) => s.monitored.includes(t.id));
  const toggleMonitor = useInput((s) => s.toggleMonitor);
  const [editing, setEditing] = useState(false);

  const rename = (name: string) => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== t.name) {
      useProject.getState().checkpoint();
      updateTrack(t.id, { name: trimmed });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "sticky left-0 z-10 flex shrink-0 cursor-default items-center gap-0.5 border-r bg-background pr-2 pl-3",
            selected && "bg-lane-selected",
          )}
          style={{ width: HEADER_W }}
          onClick={() => selectTrack(t.id)}
        >
          <span className="mr-1 h-10 w-1 shrink-0 rounded-full" style={{ background: t.color }} />
          {editing ? (
            <input
              autoFocus
              defaultValue={t.name}
              className="min-w-0 flex-1 rounded-sm border bg-background px-1 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
              aria-label="Nombre de la pista"
            />
          ) : (
            <span className="flex-1 truncate text-sm font-medium" onDoubleClick={() => setEditing(true)} title="Doble clic para renombrar">
              {t.name}
            </span>
          )}
          <Button
            size="icon-xs"
            variant={t.muted ? "secondary" : "ghost"}
            className={cn(t.muted && "text-amber-500")}
            onClick={() => updateTrack(t.id, { muted: !t.muted })}
            aria-label="Mute"
            aria-pressed={t.muted}
          >
            M
          </Button>
          <Button
            size="icon-xs"
            variant={t.soloed ? "secondary" : "ghost"}
            className={cn(t.soloed && "text-sky-500")}
            onClick={() => updateTrack(t.id, { soloed: !t.soloed })}
            aria-label="Solo"
            aria-pressed={t.soloed}
          >
            S
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(t.armed && "text-red-500")}
            onClick={() => updateTrack(t.id, { armed: !t.armed })}
            aria-label="Armar grabación"
            aria-pressed={t.armed}
          >
            R
          </Button>
          <Button
            size="icon-xs"
            variant={monitoring ? "secondary" : "ghost"}
            className={cn(monitoring && "text-emerald-500")}
            onClick={() => toggleMonitor(t.id)}
            aria-label="Monitorizar entrada"
            title="Monitorizar entrada (escucharte al tocar)"
            aria-pressed={monitoring}
          >
            <Headphones />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setTimeout(() => setEditing(true), 0)}>
          <Pencil />
          Renombrar
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={!canDelete} onSelect={() => removeTrack(t.id)}>
          <Trash2 />
          Eliminar pista
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Regla con números de compás (4/4).
 * Clic = mover el cursor. Arrastrar = crear región de loop.
 * Doble clic sobre la región o clic derecho › «Quitar loop» = borrarla.
 */
function Ruler({ bpm, pxPerSec, width, timeAt }: { bpm: number; pxPerSec: number; width: number; timeAt: (clientX: number) => number }) {
  const { loop, loopEnabled, setLoop } = useProject();
  const drag = useRef<{ x: number; t: number } | null>(null);

  const barPx = (60 / bpm) * 4 * pxPerSec;
  // Si los compases quedan muy juntos, numerar solo cada N
  const every = Math.max(1, 2 ** Math.ceil(Math.log2(40 / barPx)));
  const bars = Math.ceil(width / barPx);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative shrink-0 cursor-pointer overflow-hidden text-[11px] text-muted-foreground tabular-nums"
          style={{ width }}
          onDoubleClick={(e) => {
          const t = timeAt(e.clientX);
          if (loop && t >= loop.start && t <= loop.end) setLoop(null);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return; // el clic derecho abre el menú
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, t: snapTime(timeAt(e.clientX)) };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || Math.abs(e.clientX - d.x) < 4) return;
            const t = snapTime(timeAt(e.clientX));
            if (t !== d.t) setLoop({ start: Math.min(d.t, t), end: Math.max(d.t, t) });
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && Math.abs(e.clientX - d.x) < 4) engine.seek(timeAt(e.clientX));
          }}
        >
          {loop && (
            <div
              className={cn("absolute inset-y-1 rounded-full", loopEnabled ? "bg-foreground/20" : "bg-foreground/8")}
              style={{ left: loop.start * pxPerSec, width: (loop.end - loop.start) * pxPerSec }}
            />
          )}
          {Array.from({ length: Math.ceil(bars / every) }, (_, i) => {
            const bar = i * every;
            return (
              <span key={bar} className="absolute bottom-0 h-full border-l border-grid-line pt-1.5 pl-1.5" style={{ left: bar * barPx }}>
                {bar + 1}
              </span>
            );
          })}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!loop} onSelect={() => setLoop(null)}>
          <Repeat />
          Quitar loop
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Líneas de compás (y de tiempo si hay zoom suficiente) en el fondo de cada pista. */
function GridLines({ bpm, pxPerSec }: { bpm: number; pxPerSec: number }) {
  const barPx = (60 / bpm) * 4 * pxPerSec;
  const every = Math.max(1, 2 ** Math.ceil(Math.log2(40 / barPx)));
  const beatPx = gridSeconds(bpm, pxPerSec) * pxPerSec;
  const layers = [`repeating-linear-gradient(to right, var(--grid-line) 0 1px, transparent 1px ${barPx * every}px)`];
  if (beatPx < barPx) {
    layers.push(
      `repeating-linear-gradient(to right, color-mix(in oklch, var(--grid-line) 45%, transparent) 0 1px, transparent 1px ${beatPx}px)`,
    );
  }
  return <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: layers.join(",") }} />;
}

/** Cursor de reproducción: se actualiza cada frame sin re-renderizar React. */
function Playhead({ pxPerSec, scrollRef }: { pxPerSec: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const isPlaying = useProject((s) => s.isPlaying);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const x = engine.position() * pxPerSec;
      const el = scrollRef.current;
      if (ref.current) {
        ref.current.style.transform = `translateX(${x}px)`;
        // Oculto si queda detrás de las cabeceras de pista
        ref.current.style.visibility = el && x < el.scrollLeft ? "hidden" : "visible";
      }
      // Seguir el cursor al reproducir si se sale de la vista
      if (el && isPlaying) {
        const visibleW = el.clientWidth - HEADER_W;
        if (x < el.scrollLeft || x > el.scrollLeft + visibleW - 40) el.scrollLeft = x - 40;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [pxPerSec, isPlaying, scrollRef]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-0 bottom-0 z-[25] w-px bg-playhead"
      style={{ left: HEADER_W }}
    />
  );
}
