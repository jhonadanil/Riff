import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as engine from "@/audio/engine";
import { barSeconds, beatSeconds, useProject, type Clip, type MidiNote } from "@/store/project";
import { cn } from "@/lib/utils";

const ROW = 12; // alto de cada nota
const KEYS_W = 56;
const RULER_H = 20;
const VEL_H = 64;
const NOTES = 128;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** Divisiones de la rejilla: la figura que marca el salto mínimo (1/4 = negra). */
const DIVISIONS = [4, 8, 16, 32];

type Drag =
  | { k: "create"; index: number; t0: number }
  | { k: "move"; x: number; y: number; orig: MidiNote[]; ids: number[]; anchor: number }
  | { k: "resize"; x: number; orig: MidiNote[]; ids: number[]; anchor: number }
  | { k: "vel"; index: number };

/** Editor de notas de un clip MIDI: dibujar, mover, alargar, borrar, cuantizar y ajustar la velocidad. */
export function PianoRoll() {
  const clipId = useProject((s) => s.editingClipId);
  const clip = useProject((s) => s.clips.find((c) => c.id === clipId));
  const color = useProject((s) => s.tracks.find((t) => t.id === clip?.trackId)?.color ?? "#cba6f7");
  if (!clip?.midi) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Haz doble clic en un clip MIDI para editar sus notas.</div>;
  }
  return <Roll key={clip.id} clip={clip} color={color} />;
}

function Roll({ clip, color }: { clip: Clip; color: string }) {
  const bpm = useProject((s) => s.bpm);
  const timeSig = useProject((s) => s.timeSig);
  const snapOn = useProject((s) => s.snap);
  const [zoom, setZoom] = useState(() => Math.min(240, Math.max(30, 900 / Math.max(clip.duration, 1))));
  const [division, setDivision] = useState(16);
  const [sel, setSel] = useState<number[]>([]);
  const [draft, setDraft] = useState<MidiNote[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const velScroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);

  const notes = draft ?? clip.midi ?? [];
  const W = Math.max(1, clip.duration * zoom);
  const lo = clip.offset;
  const hi = clip.offset + clip.duration;
  const step = (60 / bpm) * (4 / division);
  const beat = beatSeconds(bpm, timeSig);
  const bar = barSeconds(bpm, timeSig);

  // Al abrir, mostrar las notas del clip (o el do central si está vacío)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mid = clip.midi?.length ? clip.midi.reduce((a, n) => a + n.n, 0) / clip.midi.length : 60;
    el.scrollTop = Math.max(0, (NOTES - 1 - mid) * ROW - el.clientHeight / 2 + RULER_H);
    // solo al abrir cada clip
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cursor de reproducción
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const x = (engine.position() - clip.start) * zoom;
      const el = playhead.current;
      if (el) {
        el.style.transform = `translateX(${x}px)`;
        el.style.visibility = x < 0 || x > W ? "hidden" : "visible";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip.start, zoom, W]);

  // --- Conversiones ---------------------------------------------------------

  /** Segundos absolutos (línea de tiempo) → tiempo de nota (segundos del clip original). */
  const toNoteTime = (abs: number) => abs - clip.start + clip.offset;
  const toAbs = (t: number) => clip.start + t - clip.offset;
  const snapAbs = (abs: number) => (snapOn ? Math.round(abs / step) * step : abs);
  const pointer = (e: React.PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const clampNote = (n: MidiNote): MidiNote => {
    const t = Math.min(Math.max(n.t, lo), hi - 0.01);
    return { ...n, t, d: Math.max(0.01, Math.min(n.d, hi - t)), n: Math.min(127, Math.max(0, n.n)) };
  };

  const commit = (next: MidiNote[]) => {
    const s = useProject.getState();
    s.checkpoint();
    s.updateClip(clip.id, { midi: next });
    setDraft(null);
  };

  // --- Ratón sobre la rejilla ---------------------------------------------------

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scroller.current?.focus({ preventScroll: true });
    const idxAttr = (e.target as HTMLElement).dataset.note;
    const { x, y } = pointer(e, e.currentTarget);

    if (idxAttr === undefined) {
      // Hueco: crear una nota nueva
      const n = NOTES - 1 - Math.floor(y / ROW);
      const t0 = Math.max(lo, toNoteTime(snapAbs(toAbs(lo + x / zoom))));
      const note = clampNote({ t: t0, d: step, n, v: 100, ch: 0 });
      const next = [...notes, note];
      drag.current = { k: "create", index: next.length - 1, t0: note.t };
      setDraft(next);
      setSel([next.length - 1]);
      return;
    }

    const i = Number(idxAttr);
    const edge = (e.target as HTMLElement).dataset.edge === "end";
    let ids = sel;
    if (e.shiftKey) {
      ids = sel.includes(i) ? sel.filter((k) => k !== i) : [...sel, i];
      setSel(ids);
      return;
    }
    if (!sel.includes(i)) {
      ids = [i];
      setSel(ids);
    }
    drag.current = edge
      ? { k: "resize", x: e.clientX, orig: notes, ids, anchor: i }
      : { k: "move", x: e.clientX, y: e.clientY, orig: notes, ids, anchor: i };
  };

  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.k === "vel") return;
    const { x, y } = pointer(e, e.currentTarget);

    if (d.k === "create") {
      const end = Math.min(hi, toNoteTime(snapAbs(toAbs(lo + x / zoom))));
      const next = (draft ?? notes).slice();
      next[d.index] = { ...next[d.index], d: Math.max(step, end - d.t0) };
      setDraft(next.map((n, i) => (i === d.index ? clampNote(n) : n)));
      return;
    }

    const group = d.ids.map((i) => d.orig[i]);
    const anchor = d.orig[d.anchor];
    if (d.k === "move") {
      let shift = snapAbs(toAbs(anchor.t) + (e.clientX - d.x) / zoom) - toAbs(anchor.t);
      shift = Math.max(lo - Math.min(...group.map((n) => n.t)), Math.min(shift, hi - Math.max(...group.map((n) => n.t + n.d))));
      let dn = -Math.round((e.clientY - d.y) / ROW);
      dn = Math.max(-Math.min(...group.map((n) => n.n)), Math.min(dn, 127 - Math.max(...group.map((n) => n.n))));
      setDraft(d.orig.map((n, i) => (d.ids.includes(i) ? { ...n, t: n.t + shift, n: n.n + dn } : n)));
    } else {
      const endAbs = toAbs(anchor.t + anchor.d);
      const delta = snapAbs(endAbs + (e.clientX - d.x) / zoom) - endAbs;
      setDraft(d.orig.map((n, i) => (d.ids.includes(i) ? clampNote({ ...n, d: Math.max(step / 2, n.d + delta) }) : n)));
    }
    void y;
  };

  const onGridUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.k === "vel") return;
    if (draft) commit(draft);
  };

  // --- Velocidad -----------------------------------------------------------------

  const velAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(127, Math.max(1, Math.round((1 - (e.clientY - r.top) / r.height) * 127)));
  };
  const onVelDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const idx = (e.target as HTMLElement).dataset.idx;
    if (idx === undefined || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = Number(idx);
    drag.current = { k: "vel", index: i };
    setSel([i]);
    setDraft(notes.map((n, k) => (k === i ? { ...n, v: velAt(e) } : n)));
  };
  const onVelMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.k !== "vel") return;
    setDraft(notes.map((n, k) => (k === d.index ? { ...n, v: velAt(e) } : n)));
  };
  const onVelUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.k === "vel" && draft) commit(draft);
  };

  // --- Teclado y acciones --------------------------------------------------------

  const remove = (ids: number[]) => {
    if (!ids.length) return;
    commit(notes.filter((_, i) => !ids.includes(i)));
    setSel([]);
  };

  const quantize = () => {
    const ids = sel.length ? sel : notes.map((_, i) => i);
    if (!ids.length) return;
    commit(
      notes.map((n, i) =>
        ids.includes(i) ? clampNote({ ...n, t: toNoteTime(Math.round(toAbs(n.t) / step) * step) }) : n,
      ),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const handle = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Delete" || e.key === "Backspace") {
      handle();
      remove(sel);
    } else if (ctrl && e.key.toLowerCase() === "a") {
      handle();
      setSel(notes.map((_, i) => i));
    } else if (sel.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      handle();
      const dn = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
      commit(notes.map((n, i) => (sel.includes(i) ? clampNote({ ...n, n: n.n + dn }) : n)));
    } else if (sel.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      handle();
      const dt = (e.key === "ArrowRight" ? 1 : -1) * step;
      commit(notes.map((n, i) => (sel.includes(i) ? clampNote({ ...n, t: n.t + dt }) : n)));
    }
  };

  // --- Rejilla (patrones SVG alineados con los compases de la canción) ---------------

  const offsetFor = (period: number) => ((((-clip.start) % period) + period) % period) * zoom;
  const bars = useMemo(() => {
    const out: { x: number; n: number }[] = [];
    for (let k = Math.ceil(clip.start / bar); k * bar < clip.start + clip.duration; k++) out.push({ x: (k * bar - clip.start) * zoom, n: k + 1 });
    return out;
  }, [clip.start, clip.duration, bar, zoom]);
  const every = Math.max(1, Math.ceil(40 / (bar * zoom)));

  return (
    <div className="flex h-full flex-col bg-background" data-pianoroll>
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs">
        <span className="font-medium" style={{ color }}>
          {clip.name}
        </span>
        <span className="text-muted-foreground">{notes.length} notas</span>
        <label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
          Rejilla
          <select
            className="h-7 rounded-sm border bg-background px-1 text-foreground outline-none focus:ring-2 focus:ring-ring"
            value={division}
            onChange={(e) => setDivision(Number(e.target.value))}
          >
            {DIVISIONS.map((d) => (
              <option key={d} value={d}>
                1/{d}
              </option>
            ))}
          </select>
        </label>
        <Button size="xs" variant="outline" onClick={quantize} title="Lleva el inicio de las notas (las seleccionadas, o todas) a la rejilla">
          Cuantizar
        </Button>
        <Button size="xs" variant="ghost" disabled={!sel.length} onClick={() => remove(sel)}>
          Borrar
        </Button>
        <span className="hidden text-muted-foreground lg:inline">Arrastra en el vacío = nota · doble clic = borrar · ↑↓ ←→ = mover</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-xs" variant="ghost" onClick={() => setZoom((z) => Math.max(10, z / 1.4))} aria-label="Alejar">
            −
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={() => setZoom((z) => Math.min(800, z * 1.4))} aria-label="Acercar">
            +
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={() => useProject.getState().openPianoRoll(null)} aria-label="Cerrar el piano roll">
            <X />
          </Button>
        </div>
      </div>

      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (velScroller.current) velScroller.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        aria-label="Notas del clip"
      >
        <div className="relative" style={{ width: KEYS_W + W, height: RULER_H + NOTES * ROW }}>
          {/* Regla: compases de la canción; clic = mover el cursor */}
          <div className="sticky top-0 z-20 flex border-b bg-background" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 shrink-0 border-r bg-background" style={{ width: KEYS_W }} />
            <div
              className="relative shrink-0 cursor-pointer overflow-hidden text-[10px] text-muted-foreground tabular-nums"
              style={{ width: W }}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                engine.seek(clip.start + (e.clientX - r.left) / zoom);
              }}
            >
              {bars
                .filter((b) => (b.n - 1) % every === 0)
                .map((b) => (
                  <span key={b.n} className="absolute h-full border-l border-grid-line pt-0.5 pl-1" style={{ left: b.x }}>
                    {b.n}
                  </span>
                ))}
            </div>
          </div>

          <div className="flex" style={{ height: NOTES * ROW }}>
            {/* Teclado */}
            <div className="sticky left-0 z-10 shrink-0 border-r bg-background" style={{ width: KEYS_W }}>
              {Array.from({ length: NOTES }, (_, k) => {
                const n = NOTES - 1 - k;
                const black = BLACK.has(n % 12);
                return (
                  <div
                    key={n}
                    className={cn(
                      "flex items-center justify-end border-b border-border/40 pr-1 text-[9px] leading-none",
                      black ? "bg-muted text-muted-foreground" : "bg-card text-muted-foreground",
                      n % 12 === 0 && "font-medium text-foreground",
                    )}
                    style={{ height: ROW }}
                  >
                    {n % 12 === 0 ? noteName(n) : ""}
                  </div>
                );
              })}
            </div>

            {/* Rejilla y notas */}
            <div
              ref={grid}
              className="relative shrink-0 cursor-crosshair"
              style={{ width: W, height: NOTES * ROW }}
              onPointerDown={onGridDown}
              onPointerMove={onGridMove}
              onPointerUp={onGridUp}
              onPointerCancel={onGridUp}
            >
              <svg className="pointer-events-none absolute inset-0" width={W} height={NOTES * ROW} aria-hidden>
                <defs>
                  <pattern id="pr-bar" x={offsetFor(bar)} width={bar * zoom} height={NOTES * ROW} patternUnits="userSpaceOnUse">
                    <rect width={1} height={NOTES * ROW} fill="var(--grid-line)" />
                  </pattern>
                  <pattern id="pr-beat" x={offsetFor(beat)} width={beat * zoom} height={NOTES * ROW} patternUnits="userSpaceOnUse">
                    <rect width={1} height={NOTES * ROW} fill="var(--grid-line)" opacity={0.55} />
                  </pattern>
                  <pattern id="pr-step" x={offsetFor(step)} width={step * zoom} height={NOTES * ROW} patternUnits="userSpaceOnUse">
                    <rect width={1} height={NOTES * ROW} fill="var(--grid-line)" opacity={0.25} />
                  </pattern>
                </defs>
                {Array.from({ length: NOTES }, (_, k) => {
                  const n = NOTES - 1 - k;
                  return BLACK.has(n % 12) ? (
                    <rect key={n} x={0} y={k * ROW} width={W} height={ROW} fill="var(--muted)" opacity={0.35} />
                  ) : n % 12 === 0 ? (
                    <rect key={n} x={0} y={k * ROW + ROW - 1} width={W} height={1} fill="var(--grid-line)" />
                  ) : null;
                })}
                {step * zoom >= 6 && <rect width={W} height={NOTES * ROW} fill="url(#pr-step)" />}
                {beat * zoom >= 8 && <rect width={W} height={NOTES * ROW} fill="url(#pr-beat)" />}
                <rect width={W} height={NOTES * ROW} fill="url(#pr-bar)" />
              </svg>

              {notes.map((n, i) => {
                if (n.t + n.d <= lo || n.t >= hi) return null;
                const selected = sel.includes(i);
                return (
                  <div
                    key={i}
                    data-note={i}
                    className={cn(
                      "absolute cursor-grab overflow-hidden rounded-[3px] border",
                      selected ? "z-[3] border-foreground" : "border-black/30",
                    )}
                    style={{
                      left: (n.t - lo) * zoom,
                      width: Math.max(4, n.d * zoom),
                      top: (NOTES - 1 - n.n) * ROW + 1,
                      height: ROW - 2,
                      background: color,
                      opacity: 0.4 + (n.v / 127) * 0.6,
                    }}
                    onDoubleClick={() => remove([i])}
                    title={`${noteName(n.n)} · velocidad ${n.v}`}
                  >
                    <span data-note={i} data-edge="end" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" />
                  </div>
                );
              })}
              <div ref={playhead} className="pointer-events-none absolute inset-y-0 left-0 z-[4] w-px bg-playhead" />
            </div>
          </div>
        </div>
      </div>

      {/* Velocidad de cada nota */}
      <div className="flex shrink-0 border-t" style={{ height: VEL_H }}>
        <div className="flex shrink-0 items-center justify-center border-r text-[10px] text-muted-foreground" style={{ width: KEYS_W }}>
          Veloc.
        </div>
        <div ref={velScroller} className="min-w-0 flex-1 overflow-hidden">
          <div
            className="relative cursor-ns-resize"
            style={{ width: W, height: VEL_H }}
            onPointerDown={onVelDown}
            onPointerMove={onVelMove}
            onPointerUp={onVelUp}
            onPointerCancel={onVelUp}
          >
            {notes.map((n, i) =>
              n.t + n.d <= lo || n.t >= hi ? null : (
                <div
                  key={i}
                  data-idx={i}
                  className={cn("absolute bottom-0 w-1.5 rounded-t-sm", sel.includes(i) ? "bg-foreground" : "")}
                  style={{ left: (n.t - lo) * zoom, height: `${(n.v / 127) * 100}%`, background: sel.includes(i) ? undefined : color }}
                  title={`Velocidad ${n.v}`}
                />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
