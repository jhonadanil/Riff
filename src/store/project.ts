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
  /** Entrada de la interfaz de la que toma el sonido (al monitorizar y al grabar). Sin definir: la predeterminada. */
  input?: "1" | "2" | "stereo";
  /** Grabar lo que sale de los plugins de la pista (con el ampli puesto) en vez de la señal limpia. */
  recordFx?: boolean;
  /** Dispositivo MIDI del que toma las notas (sin definir: cualquiera). */
  midiPort?: string;
  /** Bus al que va la pista (sin definir: directa al master). */
  out?: string;
  /** Envíos a buses: id del bus -> nivel (0..1, tras el fader). */
  sends?: Record<string, number>;
  /** Automatización (envolventes) de la pista. Con puntos, manda sobre el fader mientras suena. */
  automation?: { volume?: AutoPoint[]; pan?: AutoPoint[] };
  /** Ignorar la automatización (se usa el fader). */
  autoOff?: boolean;
};

/** Punto de una envolvente: tiempo (s) y valor (volumen 0..1, pan -1..1). */
export type AutoPoint = { t: number; v: number };
export type AutoParam = "volume" | "pan";

/** Bus: grupo de pistas con su propio fader (batería, guitarras, retorno de reverb…). */
export type Bus = {
  id: string;
  name: string;
  color: string;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
};

/** Una nota de un clip MIDI. Los tiempos cuentan desde el inicio del clip original (segundos). */
export type MidiNote = {
  /** Inicio. */
  t: number;
  /** Duración. */
  d: number;
  /** Nota MIDI (0-127). */
  n: number;
  /** Velocidad (1-127). */
  v: number;
  /** Canal MIDI (0-15). */
  ch: number;
};

/** Un fragmento de audio (o de notas MIDI) colocado en una pista. Tiempos en segundos. */
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
  /** Si es un clip MIDI: sus notas (y no tiene audio). */
  midi?: MidiNote[];
  /** Ganancia del clip (lineal, 1 = sin cambios). */
  gain?: number;
  /** Fundido de entrada y de salida (s). */
  fadeIn?: number;
  fadeOut?: number;
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
type Snapshot = { tracks: Track[]; clips: Clip[]; buses: Bus[] };
const HISTORY_LIMIT = 100;
const snap = (s: { tracks: Track[]; clips: Clip[]; buses: Bus[] }): Snapshot => ({
  tracks: s.tracks,
  clips: s.clips,
  buses: s.buses,
});

/** Compás: tiempos por compás y figura que hace de tiempo (4 = negra, 8 = corchea). */
export type TimeSig = [beats: number, unit: number];
export const TIME_SIGS: TimeSig[] = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [3, 8], [6, 8], [7, 8], [9, 8], [12, 8]];

/** Duración de un tiempo en segundos (el BPM cuenta negras). */
export const beatSeconds = (bpm: number, sig: TimeSig) => (60 / bpm) * (4 / sig[1]);
export const barSeconds = (bpm: number, sig: TimeSig) => beatSeconds(bpm, sig) * sig[0];

/** Ajustes del click del metrónomo (de la app, no del proyecto). */
const CLICK_KEY = "riff.metronome";
export type ClickPrefs = { volume: number; eighths: boolean };
function readClick(): ClickPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(CLICK_KEY) ?? "{}");
    return { volume: typeof v.volume === "number" ? v.volume : -10, eighths: v.eighths === true };
  } catch {
    return { volume: -10, eighths: false };
  }
}

type ProjectState = {
  bpm: number;
  timeSig: TimeSig;
  click: ClickPrefs;
  isPlaying: boolean;
  tracks: Track[];
  clips: Clip[];
  buses: Bus[];
  /** Volumen del master (0..1). */
  master: number;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  /** Todos los clips seleccionados (selectedClipId es el último que se tocó). */
  selectedClipIds: string[];
  /** Clip MIDI abierto en el piano roll. */
  editingClipId: string | null;
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
  setTimeSig: (sig: TimeSig) => void;
  setClick: (click: Partial<ClickPrefs>) => void;
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

  /** Añade una pista (con la configuración dada, si la hay) y devuelve su id. */
  addTrack: (init?: Partial<Omit<Track, "id">>) => string;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  selectTrack: (id: string) => void;
  setMaster: (v: number) => void;

  addBus: () => void;
  removeBus: (id: string) => void;
  updateBus: (id: string, patch: Partial<Bus>) => void;

  setAutomation: (trackId: string, param: AutoParam, points: AutoPoint[]) => void;

  addClip: (clip: Clip) => void;
  /** Crea un clip MIDI vacío (para dibujar notas en el piano roll). */
  addMidiClip: (trackId: string, start: number, duration: number) => string;
  openPianoRoll: (clipId: string | null) => void;
  /** Aplica un cambio a varios clips con un solo paso de deshacer. */
  updateClips: (ids: string[], fn: (c: Clip) => Partial<Clip>) => void;
  removeClips: (ids: string[]) => void;
  copySelection: () => boolean;
  /** Pega lo copiado en `time`, empezando en la pista `trackId`. */
  paste: (time: number, trackId: string | null) => void;
  duplicateSelection: () => void;
  selectAllClips: () => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  selectClip: (id: string | null, additive?: boolean) => void;
  /** Divide en `time` los clips de la pista seleccionada (o el clip seleccionado). */
  splitAt: (time: number) => void;
};

/** Lo que se guarda en el archivo .riff. */
export type ProjectData = {
  bpm: number;
  timeSig: TimeSig;
  tracks: Track[];
  clips: Clip[];
  buses?: Bus[];
  master?: number;
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

/** Proyecto nuevo: sin pistas, se añaden con «+». */
export function emptyProject(): ProjectData {
  return {
    bpm: 120,
    timeSig: [4, 4],
    tracks: [],
    clips: [],
    buses: [],
    master: 1,
    loop: null,
    loopEnabled: false,
  };
}

/** Lo copiado (Ctrl+C): cada clip con su fila relativa y su posición relativa. */
let clipboard: { clip: Clip; row: number; at: number }[] = [];
export const hasClipboard = () => clipboard.length > 0;

const initial = emptyProject();
let suppressDirty = false;

export const useProject = create<ProjectState>((set, get) => ({
  ...initial,
  buses: [],
  master: 1,
  click: readClick(),
  isPlaying: false,
  selectedTrackId: initial.tracks[0]?.id ?? null,
  selectedClipId: null,
  selectedClipIds: [],
  editingClipId: null,
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
      buses: data.buses ?? [],
      master: data.master ?? 1,
      projectPath,
      dirty: false,
      past: [],
      future: [],
      selectedClipId: null,
      selectedClipIds: [],
      editingClipId: null,
      selectedTrackId: data.tracks[0]?.id ?? null,
      isPlaying: false,
    });
    suppressDirty = false;
  },
  markSaved: (projectPath) => set({ projectPath, dirty: false }),

  setBpm: (bpm) => set({ bpm }),
  setTimeSig: (timeSig) => set({ timeSig }),
  setClick: (click) => {
    const next = { ...get().click, ...click };
    try {
      localStorage.setItem(CLICK_KEY, JSON.stringify(next));
    } catch {
      // sin almacenamiento
    }
    set({ click: next });
  },
  setPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSec)) }),
  toggleSnap: () => set((s) => ({ snap: !s.snap })),
  toggleMetronome: () => set((s) => ({ metronome: !s.metronome })),
  toggleCountIn: () => set((s) => ({ countIn: !s.countIn })),
  setLoop: (loop) => set({ loop, loopEnabled: loop !== null }),
  toggleLoop: () => set((s) => ({ loopEnabled: s.loop ? !s.loopEnabled : false })),

  checkpoint: () =>
    set((s) => ({
      past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: [],
    })),
  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return {
        ...prev,
        past: s.past.slice(0, -1),
        future: [snap(s), ...s.future],
        selectedClipId: null,
        selectedClipIds: [],
        editingClipId: null,
      };
    }),
  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return s;
      return {
        ...next,
        past: [...s.past, snap(s)],
        future: s.future.slice(1),
        selectedClipId: null,
        selectedClipIds: [],
        editingClipId: null,
      };
    }),

  addTrack: (init) => {
    get().checkpoint();
    const n = get().tracks.length + 1;
    const t = { ...track(crypto.randomUUID(), `Pista ${n}`, TRACK_COLORS[(n - 1) % TRACK_COLORS.length]), ...init, armed: false };
    set((s) => ({ tracks: [...s.tracks, t], selectedTrackId: t.id }));
    return t.id;
  },
  removeTrack: (id) => {
    get().checkpoint();
    set((s) => {
      const gone = new Set(s.clips.filter((c) => c.trackId === id).map((c) => c.id));
      return {
        tracks: s.tracks.filter((t) => t.id !== id),
        clips: s.clips.filter((c) => c.trackId !== id),
        selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
        selectedClipIds: s.selectedClipIds.filter((c) => !gone.has(c)),
        editingClipId: s.editingClipId && gone.has(s.editingClipId) ? null : s.editingClipId,
      };
    });
  },
  updateTrack: (id, patch) =>
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  selectTrack: (selectedTrackId) => set({ selectedTrackId }),
  setMaster: (master) => set({ master: Math.min(1.5, Math.max(0, master)) }),

  addBus: () => {
    get().checkpoint();
    set((s) => {
      const n = s.buses.length + 1;
      const bus: Bus = {
        id: crypto.randomUUID(),
        name: `Bus ${n}`,
        color: TRACK_COLORS[(n + 3) % TRACK_COLORS.length],
        volume: 0.8,
        pan: 0,
        muted: false,
        soloed: false,
      };
      return { buses: [...s.buses, bus] };
    });
  },
  removeBus: (id) => {
    get().checkpoint();
    set((s) => ({
      buses: s.buses.filter((b) => b.id !== id),
      tracks: s.tracks.map((t) => {
        if (t.out !== id && !(t.sends && id in t.sends)) return t;
        const sends = { ...t.sends };
        delete sends[id];
        return { ...t, out: t.out === id ? undefined : t.out, sends };
      }),
    }));
  },
  updateBus: (id, patch) => set((s) => ({ buses: s.buses.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),

  setAutomation: (trackId, param, points) =>
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        return { ...t, automation: { ...t.automation, [param]: points.length ? points : undefined } };
      }),
    })),

  addClip: (clip) => set((s) => ({ clips: [...s.clips, clip] })),
  addMidiClip: (trackId, start, duration) => {
    get().checkpoint();
    const id = crypto.randomUUID();
    set((s) => ({
      clips: [
        ...s.clips,
        { id, trackId, name: "MIDI", start: Math.max(0, start), offset: 0, duration, sourceDuration: duration, bufferId: "", midi: [] },
      ],
      selectedClipId: id,
      selectedClipIds: [id],
      selectedTrackId: trackId,
    }));
    return id;
  },
  openPianoRoll: (editingClipId) => set({ editingClipId }),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  updateClips: (ids, fn) => {
    const target = new Set(ids);
    if (!target.size) return;
    get().checkpoint();
    set((s) => ({ clips: s.clips.map((c) => (target.has(c.id) ? { ...c, ...fn(c) } : c)) }));
  },
  removeClip: (id) => get().removeClips([id]),
  removeClips: (ids) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    get().checkpoint();
    set((s) => ({
      clips: s.clips.filter((c) => !gone.has(c.id)),
      selectedClipId: s.selectedClipId && gone.has(s.selectedClipId) ? null : s.selectedClipId,
      selectedClipIds: s.selectedClipIds.filter((c) => !gone.has(c)),
      editingClipId: s.editingClipId && gone.has(s.editingClipId) ? null : s.editingClipId,
    }));
  },
  selectClip: (id, additive = false) => {
    if (id === null) {
      set({ selectedClipId: null, selectedClipIds: [] });
      return;
    }
    const s = get();
    const clip = s.clips.find((c) => c.id === id);
    let ids: string[];
    if (additive) ids = s.selectedClipIds.includes(id) ? s.selectedClipIds.filter((c) => c !== id) : [...s.selectedClipIds, id];
    else ids = s.selectedClipIds.includes(id) ? s.selectedClipIds : [id];
    set({
      selectedClipIds: ids,
      selectedClipId: ids.includes(id) ? id : (ids[ids.length - 1] ?? null),
      ...(clip && { selectedTrackId: clip.trackId }),
    });
  },
  selectAllClips: () => set((s) => ({ selectedClipIds: s.clips.map((c) => c.id), selectedClipId: s.clips[0]?.id ?? null })),

  copySelection: () => {
    const s = get();
    const picked = s.clips.filter((c) => s.selectedClipIds.includes(c.id));
    if (!picked.length) return false;
    const rows = picked.map((c) => s.tracks.findIndex((t) => t.id === c.trackId));
    const firstRow = Math.min(...rows);
    const firstStart = Math.min(...picked.map((c) => c.start));
    clipboard = picked.map((c, i) => ({ clip: c, row: rows[i] - firstRow, at: c.start - firstStart }));
    return true;
  },
  paste: (time, trackId) => {
    if (!clipboard.length) return;
    const s = get();
    const base = trackId ? s.tracks.findIndex((t) => t.id === trackId) : -1;
    const baseRow = base >= 0 ? base : Math.max(0, s.tracks.findIndex((t) => t.id === clipboard[0].clip.trackId));
    s.checkpoint();
    const made = clipboard.map(({ clip, row, at }) => {
      const target = s.tracks[Math.min(s.tracks.length - 1, baseRow + row)];
      return { ...clip, id: crypto.randomUUID(), trackId: target.id, start: Math.max(0, time + at) };
    });
    set((st) => ({
      clips: [...st.clips, ...made],
      selectedClipIds: made.map((c) => c.id),
      selectedClipId: made[0].id,
      selectedTrackId: made[0].trackId,
    }));
  },
  duplicateSelection: () => {
    const s = get();
    const picked = s.clips.filter((c) => s.selectedClipIds.includes(c.id));
    if (!picked.length) return;
    const keep = clipboard;
    get().copySelection();
    const end = Math.max(...picked.map((c) => c.start + c.duration));
    const row = Math.min(...picked.map((c) => s.tracks.findIndex((t) => t.id === c.trackId)));
    get().paste(end, s.tracks[row]?.id ?? null);
    clipboard = keep.length ? keep : clipboard;
  },

  splitAt: (time) => {
    const s = get();
    const targets = s.clips.filter(
      (c) =>
        (s.selectedClipIds.length ? s.selectedClipIds.includes(c.id) : c.trackId === s.selectedTrackId) &&
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
    set({ clips: [...s.clips.filter((c) => !ids.has(c.id)), ...pieces], selectedClipId: null, selectedClipIds: [] });
  },
}));

/** Rejilla de ajuste en segundos: un tiempo (negra), o un compás si hay poco zoom. */
export function gridSeconds(bpm: number, pxPerSec: number, sig: TimeSig = useProject.getState().timeSig) {
  const beat = beatSeconds(bpm, sig);
  return beat * pxPerSec >= 16 ? beat : beat * sig[0];
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
    s.buses !== prev.buses ||
    s.master !== prev.master ||
    s.bpm !== prev.bpm ||
    s.timeSig !== prev.timeSig ||
    s.loop !== prev.loop ||
    s.loopEnabled !== prev.loopEnabled
  ) {
    useProject.setState({ dirty: true });
  }
});
