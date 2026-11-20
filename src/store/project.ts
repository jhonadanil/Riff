import { create } from "zustand";

export type Track = {
  id: string;
  name: string;
  color: string;
  volume: number; // 0..1
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
  armed: boolean;
};

/** Un fragmento de audio colocado en una pista. Tiempos en segundos. */
export type Clip = {
  id: string;
  trackId: string;
  name: string;
  /** Posición en la línea de tiempo. */
  start: number;
  /** Desde qué punto del audio original empieza a sonar (recorte izquierdo). */
  offset: number;
  /** Duración audible (recorte derecho). */
  duration: number;
  /** Referencia al audio decodificado que guarda el motor (src/audio/engine.ts). */
  bufferId: string;
  /** Duración total del audio original, límite para el recorte. */
  sourceDuration: number;
};

export type LoopRegion = { start: number; end: number };

export const MIN_ZOOM = 10; // px por segundo
export const MAX_ZOOM = 400;
export const TRACK_COLORS = [
  "#cba6f7", // mauve
  "#89b4fa", // blue
  "#a6e3a1", // green
  "#fab387", // peach
  "#f5c2e7", // pink
  "#94e2d5", // teal
  "#f9e2af", // yellow
  "#f38ba8", // red
];

/** Lo que se guarda en el historial de deshacer. */
type Snapshot = { tracks: Track[]; clips: Clip[] };
const HISTORY_LIMIT = 100;

type ProjectState = {
  bpm: number;
  isPlaying: boolean;
  tracks: Track[];
  clips: Clip[];
  selectedTrackId: string | null;
  selectedClipId: string | null;
  /** Zoom horizontal de la línea de tiempo, en píxeles por segundo. */
  pxPerSec: number;
  snap: boolean;
  metronome: boolean;
  /** Un compás de clics antes de empezar a grabar. */
  countIn: boolean;
  loop: LoopRegion | null;
  loopEnabled: boolean;
  past: Snapshot[];
  future: Snapshot[];
  /** Ruta del archivo .riff abierto (null = proyecto sin guardar). */
  projectPath: string | null;
  /** Hay cambios sin guardar. */
  dirty: boolean;

  /** Sustituye el proyecto entero (nuevo o abierto desde disco). */
  loadProject: (data: ProjectData, path: string | null) => void;
  markSaved: (path: string) => void;

  setBpm: (bpm: number) => void;
  setPlaying: (v: boolean) => void;
  setZoom: (pxPerSec: number) => void;
  toggleSnap: () => void;
  toggleMetronome: () => void;
  toggleCountIn: () => void;
  setLoop: (loop: LoopRegion | null) => void;
  toggleLoop: () => void;

  /** Guarda el estado actual en el historial; llamar antes de un cambio que se pueda deshacer. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  addTrack: () => void;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  selectTrack: (id: string) => void;

  addClip: (clip: Clip) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  selectClip: (id: string | null) => void;
  /** Divide en `time` los clips de la pista seleccionada (o el clip seleccionado). */
  splitAt: (time: number) => void;
};

/** Lo que se guarda en el archivo .riff. */
export type ProjectData = {
  bpm: number;
  tracks: Track[];
  clips: Clip[];
  loop: LoopRegion | null;
  loopEnabled: boolean;
};

const track = (id: string, name: string, color: string, pan = 0): Track => ({
  id,
  name,
  color,
  volume: 0.8,
  pan,
  muted: false,
  soloed: false,
  armed: false,
});

/** Plantilla de proyecto nuevo: las pistas típicas de una banda de rock. */
export function emptyProject(): ProjectData {
  return {
    bpm: 120,
    tracks: [
      track(crypto.randomUUID(), "Guitarra", TRACK_COLORS[0]),
      track(crypto.randomUUID(), "Bajo", TRACK_COLORS[1]),
      track(crypto.randomUUID(), "Batería", TRACK_COLORS[2]),
      track(crypto.randomUUID(), "Voz", TRACK_COLORS[3]),
    ],
    clips: [],
    loop: null,
    loopEnabled: false,
  };
}

const initial = emptyProject();
let suppressDirty = false;

export const useProject = create<ProjectState>((set, get) => ({
  ...initial,
  isPlaying: false,
  selectedTrackId: initial.tracks[0].id,
  selectedClipId: null,
  pxPerSec: 50,
  snap: true,
  metronome: false,
  countIn: true,
  past: [],
  future: [],
  projectPath: null,
  dirty: false,

  loadProject: (data, projectPath) => {
    suppressDirty = true;
    set({
      ...data,
      projectPath,
      dirty: false,
      past: [],
      future: [],
      selectedClipId: null,
      selectedTrackId: data.tracks[0]?.id ?? null,
      isPlaying: false,
    });
    suppressDirty = false;
  },
  markSaved: (projectPath) => set({ projectPath, dirty: false }),

  setBpm: (bpm) => set({ bpm }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSec)) }),
  toggleSnap: () => set((s) => ({ snap: !s.snap })),
  toggleMetronome: () => set((s) => ({ metronome: !s.metronome })),
  toggleCountIn: () => set((s) => ({ countIn: !s.countIn })),
  setLoop: (loop) => set({ loop, loopEnabled: loop !== null }),
  toggleLoop: () => set((s) => ({ loopEnabled: s.loop ? !s.loopEnabled : false })),

  checkpoint: () =>
    set((s) => ({
      past: [...s.past, { tracks: s.tracks, clips: s.clips }].slice(-HISTORY_LIMIT),
      future: [],
    })),
  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return {
        ...prev,
        past: s.past.slice(0, -1),
        future: [{ tracks: s.tracks, clips: s.clips }, ...s.future],
        selectedClipId: null,
      };
    }),
  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return s;
      return {
        ...next,
        past: [...s.past, { tracks: s.tracks, clips: s.clips }],
        future: s.future.slice(1),
        selectedClipId: null,
      };
    }),

  addTrack: () => {
    get().checkpoint();
    set((s) => {
      const n = s.tracks.length + 1;
      const t = track(crypto.randomUUID(), `Pista ${n}`, TRACK_COLORS[(n - 1) % TRACK_COLORS.length]);
      return { tracks: [...s.tracks, t], selectedTrackId: t.id };
    });
  },
  removeTrack: (id) => {
    get().checkpoint();
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      clips: s.clips.filter((c) => c.trackId !== id),
      selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
    }));
  },
  updateTrack: (id, patch) =>
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  selectTrack: (selectedTrackId) => set({ selectedTrackId }),

  addClip: (clip) => set((s) => ({ clips: [...s.clips, clip] })),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeClip: (id) => {
    get().checkpoint();
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
    }));
  },
  selectClip: (selectedClipId) => {
    const clip = get().clips.find((c) => c.id === selectedClipId);
    set({ selectedClipId, ...(clip && { selectedTrackId: clip.trackId }) });
  },

  splitAt: (time) => {
    const s = get();
    const targets = s.clips.filter(
      (c) =>
        (s.selectedClipId ? c.id === s.selectedClipId : c.trackId === s.selectedTrackId) &&
        time > c.start + 0.001 &&
        time < c.start + c.duration - 0.001,
    );
    if (!targets.length) return;
    s.checkpoint();
    const ids = new Set(targets.map((c) => c.id));
    const pieces = targets.flatMap((c) => {
      const left = time - c.start;
      return [
        { ...c, duration: left },
        { ...c, id: crypto.randomUUID(), start: time, offset: c.offset + left, duration: c.duration - left },
      ];
    });
    set({ clips: [...s.clips.filter((c) => !ids.has(c.id)), ...pieces], selectedClipId: null });
  },
}));

/** Rejilla de ajuste en segundos: un tiempo (negra), o un compás si hay poco zoom. */
export function gridSeconds(bpm: number, pxPerSec: number) {
  const beat = 60 / bpm;
  return beat * pxPerSec >= 16 ? beat : beat * 4;
}

export function snapTime(t: number) {
  const { snap, bpm, pxPerSec } = useProject.getState();
  if (!snap) return t;
  const g = gridSeconds(bpm, pxPerSec);
  return Math.round(t / g) * g;
}

// Cualquier cambio en lo que se guarda marca el proyecto como modificado
useProject.subscribe((s, prev) => {
  if (s.dirty || suppressDirty) return;
  if (
    s.tracks !== prev.tracks ||
    s.clips !== prev.clips ||
    s.bpm !== prev.bpm ||
    s.loop !== prev.loop ||
    s.loopEnabled !== prev.loopEnabled
  ) {
    useProject.setState({ dirty: true });
  }
});
