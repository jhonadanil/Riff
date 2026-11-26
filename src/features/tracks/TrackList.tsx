import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, ChevronDown, ClipboardPaste, Headphones, Music2, Pencil, Plus, Repeat, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { addTrackFromPreset, deleteTrackPreset, saveTrackPreset, useTrackPresets } from "@/store/trackPresets";
import { barSeconds, gridSeconds, hasClipboard, snapTime, useProject, type AutoParam, type Track } from "@/store/project";
import * as engine from "@/audio/engine";
import { useInput } from "@/audio/input";
import { subscribeLevels } from "@/audio/levels";
import { cn } from "@/lib/utils";
import { ClipView, TRACK_H } from "./ClipView";
import { RecordingClip, useRecordingEnd } from "./RecordingClip";
import { importAudioFiles } from "./importAudio";
import { useTrackKind } from "@/audio/chains";
import { TrackInputMenu } from "./TrackInput";
import { TrackMidiMenu } from "./TrackMidi";
import { TrackPluginsButton } from "./TrackPlugins";
import { AutomationLane, showAutomation, useAutomationUi } from "./AutomationLane";

const HEADER_W = 280; // ancho de la cabecera de pista
const RULER_H = 28;
const MIN_LENGTH_SEC = engine.EMPTY_SONG_SEC; // la línea de tiempo nunca es más corta que esto
const TAIL_SEC = 30; // espacio libre tras el último clip

export function TrackList() {
  const { tracks, clips, bpm, pxPerSec, loop, loopEnabled, selectTrack, setZoom, addTrack, selectedTrackId: selectedId } = useProject();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  const shownAutomation = useAutomationUi((s) => s.shown);
  /** Dónde se hizo clic derecho en la línea de tiempo (para pegar o crear un clip ahí). */
  const menuTime = useRef(0);

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

        {/* Pistas (el cursor y el loop solo cubren esta zona, no el botón de añadir) */}
        <div className="relative">
        {tracks.map((t) => (
          <div key={t.id} className="flex border-b" style={{ height: TRACK_H }}>
            <TrackHeader track={t} canDelete />

            <ContextMenu>
              <ContextMenuTrigger asChild>
            <div
              onContextMenuCapture={(e) => (menuTime.current = snapTime(timeAt(e.clientX)))}
              className={cn(
                "relative flex-1 bg-lane transition-colors",
                selectedId === t.id && "bg-lane-selected",
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
              {shownAutomation[t.id] && <AutomationLane track={t} param={shownAutomation[t.id]!} pxPerSec={pxPerSec} />}
            </div>
              </ContextMenuTrigger>
              <LaneMenu track={t} timeRef={menuTime} />
            </ContextMenu>
          </div>
        ))}

        {/* Región de loop sobre las pistas */}
        {loop && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-0 z-[4] border-x",
              loopEnabled ? "border-foreground/35 bg-foreground/[0.045]" : "border-dashed border-foreground/15",
            )}
            style={{ top: 0, left: HEADER_W + loop.start * pxPerSec, width: (loop.end - loop.start) * pxPerSec }}
          />
        )}

        <Playhead pxPerSec={pxPerSec} scrollRef={scrollRef} />
        </div>

        <div className="sticky left-0 flex w-fit items-center gap-4 px-3 py-2">
          <AddTrackMenu onEmpty={() => addTrack()} />
        </div>
      </div>
    </div>
  );
}

/** «Añadir pista» (vacía) y, en la flecha, las plantillas con su entrada, MIDI y plugins ya configurados. */
function AddTrackMenu({ onEmpty }: { onEmpty: () => void }) {
  const presets = useTrackPresets((s) => s.list);
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="sm" className="rounded-r-none pr-2" onClick={onEmpty}>
        <Plus />
        Añadir pista
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="rounded-l-none border-l-border px-1.5" aria-label="Añadir desde plantilla" title="Añadir desde plantilla">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuLabel>Añadir desde plantilla</DropdownMenuLabel>
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => void addTrackFromPreset(p)} className="group gap-2">
              <span className="h-3 w-1 rounded-full" style={{ background: p.color }} />
              <span className="flex-1">{p.name}</span>
              {!p.builtin && (
                <button
                  className="rounded p-0.5 opacity-0 group-focus:opacity-100 hover:bg-foreground/10 group-hover:opacity-100"
                  aria-label={`Borrar la plantilla ${p.name}`}
                  title="Borrar plantilla"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    deleteTrackPreset(p.id);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onEmpty}>
            <Plus />
            Pista vacía
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Menú del área de una pista: pegar y crear clips MIDI donde se hizo clic. */
function LaneMenu({ track, timeRef }: { track: Track; timeRef: React.RefObject<number> }) {
  const kind = useTrackKind(track.id);
  const bpm = useProject((s) => s.bpm);
  const timeSig = useProject((s) => s.timeSig);
  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!hasClipboard()}
        onSelect={() => useProject.getState().paste(timeRef.current, track.id)}
      >
        <ClipboardPaste />
        Pegar aquí
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>
      {kind === "midi" && (
        <ContextMenuItem
          onSelect={() => {
            const s = useProject.getState();
            const id = s.addMidiClip(track.id, timeRef.current, barSeconds(bpm, timeSig) * 2);
            s.openPianoRoll(id);
          }}
        >
          <Music2 />
          Crear clip MIDI aquí (2 compases)
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

/** Nivel de la entrada de esta pista: sirve para ver de un vistazo que cada una recibe lo que toca. */
function TrackMeter({ track }: { track: Track }) {
  const bar = useRef<HTMLDivElement>(null);
  const channel = useInput((s) => s.channel);
  const sel = track.input ?? channel;
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    let shown = 0;
    return subscribeLevels(({ peaks }) => {
      const el = bar.current;
      if (!el) return;
      const p = selRef.current === "1" ? peaks[0] : selRef.current === "2" ? peaks[1] : Math.max(peaks[0], peaks[1]);
      // Cae poco a poco para que los golpes se vean
      shown = Math.max(p, shown * 0.8);
      el.style.width = `${Math.min(100, Math.sqrt(shown) * 100)}%`;
      el.style.background = shown > 0.9 ? "var(--rec)" : shown > 0.5 ? "var(--warn)" : "var(--ok)";
    });
  }, []);

  return (
    <div
      className="pointer-events-none absolute right-2 bottom-1 left-3 h-1 overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-label={`Nivel de entrada de ${track.name}`}
    >
      <div ref={bar} className="h-full w-0 rounded-full" />
    </div>
  );
}

function TrackHeader({ track: t, canDelete }: { track: Track; canDelete: boolean }) {
  const selected = useProject((s) => s.selectedTrackId === t.id);
  const { updateTrack, selectTrack, removeTrack } = useProject();
  const kind = useTrackKind(t.id);
  const monitoring = useInput((s) => s.monitored.includes(t.id));
  const toggleMonitor = useInput((s) => s.toggleMonitor);
  const [editing, setEditing] = useState(false);
  const shown = useAutomationUi((s) => s.shown[t.id]);

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
          <span className={cn("mr-1 h-10 shrink-0 rounded-full transition-[width]", selected ? "w-1.5" : "w-1")} style={{ background: t.color }} />
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
            <span
              className={cn("flex-1 truncate text-sm", selected ? "font-semibold" : "font-medium text-foreground/70")}
              onDoubleClick={() => setEditing(true)} title="Doble clic para renombrar">
              {t.name}
            </span>
          )}
          {kind === "midi" ? <TrackMidiMenu track={t} /> : <TrackInputMenu track={t} />}
          <Button
            size="icon-xs"
            variant={t.muted ? "secondary" : "ghost"}
            className={cn(t.muted && "text-warn")}
            onClick={() => updateTrack(t.id, { muted: !t.muted })}
            aria-label="Mute"
            aria-pressed={t.muted}
          >
            M
          </Button>
          <Button
            size="icon-xs"
            variant={t.soloed ? "secondary" : "ghost"}
            className={cn(t.soloed && "text-solo")}
            onClick={() => updateTrack(t.id, { soloed: !t.soloed })}
            aria-label="Solo"
            aria-pressed={t.soloed}
          >
            S
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(t.armed && "text-rec")}
            onClick={() => updateTrack(t.id, { armed: !t.armed })}
            aria-label="Armar grabación"
            title="Armar la pista para grabar en ella"
            aria-pressed={t.armed}
          >
            R
          </Button>
          {kind === "audio" && (
            <Button
              size="icon-xs"
              variant={monitoring ? "secondary" : "ghost"}
              className={cn(monitoring && "text-ok")}
              onClick={() => toggleMonitor(t.id)}
              aria-label="Monitorizar entrada"
              title="Escucharte al tocar (con los plugins de esta pista)"
              aria-pressed={monitoring}
            >
              <Headphones />
            </Button>
          )}
          <TrackPluginsButton track={t} />
          {kind === "audio" && <TrackMeter track={t} />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setTimeout(() => setEditing(true), 0)}>
          <Pencil />
          Renombrar
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Automatización</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={shown ?? "none"} onValueChange={(v) => showAutomation(t.id, v === "none" ? undefined : (v as AutoParam))}>
              <ContextMenuRadioItem value="none">Ocultar</ContextMenuRadioItem>
              <ContextMenuRadioItem value="volume">Mostrar volumen</ContextMenuRadioItem>
              <ContextMenuRadioItem value="pan">Mostrar pan</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem checked={!t.autoOff} onCheckedChange={(v) => updateTrack(t.id, { autoOff: v !== true })}>
              Seguir la automatización
            </ContextMenuCheckboxItem>
            <ContextMenuItem
              variant="destructive"
              disabled={!t.automation?.volume && !t.automation?.pan}
              onSelect={() => {
                useProject.getState().checkpoint();
                useProject.getState().setAutomation(t.id, "volume", []);
                useProject.getState().setAutomation(t.id, "pan", []);
              }}
            >
              Borrar las envolventes
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void saveTrackPreset(t.id)}>
          <BookmarkPlus />
          Guardar como plantilla
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={!canDelete} onSelect={() => removeTrack(t.id)}>
          <Trash2 />
          Eliminar pista
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Regla con números de compás.
 * Clic = mover el cursor. Arrastrar = crear región de loop.
 * Doble clic sobre la región o clic derecho › «Quitar loop» = borrarla.
 */
function Ruler({ bpm, pxPerSec, width, timeAt }: { bpm: number; pxPerSec: number; width: number; timeAt: (clientX: number) => number }) {
  const { loop, loopEnabled, setLoop, timeSig } = useProject();
  const drag = useRef<{ x: number; t: number } | null>(null);

  const barPx = barSeconds(bpm, timeSig) * pxPerSec;
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
  const timeSig = useProject((s) => s.timeSig);
  const barPx = barSeconds(bpm, timeSig) * pxPerSec;
  const every = Math.max(1, 2 ** Math.ceil(Math.log2(40 / barPx)));
  const beatPx = gridSeconds(bpm, pxPerSec, timeSig) * pxPerSec;
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
      className="pointer-events-none absolute bottom-0 z-[25] w-px bg-playhead"
      style={{ left: HEADER_W, top: -RULER_H }}
    />
  );
}
