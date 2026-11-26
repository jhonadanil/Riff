import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "sonner";
import { useProject, type Track } from "@/store/project";

/** Plantilla de pista: nombre, color, entrada, MIDI, mezcla y plugins (con sus ajustes). */
export type TrackPreset = {
  id: string;
  name: string;
  color: string;
  volume: number;
  pan: number;
  input?: Track["input"];
  recordFx?: boolean;
  midiPort?: string;
  /** Plugins tal como los guarda el motor (ruta, bypass y estado). */
  plugins: unknown[];
  /** Las de fábrica no se pueden borrar (sí sobrescribir al guardar otra con el mismo nombre). */
  builtin?: boolean;
};

const KEY = "riff-studio.trackPresets";

const base = (id: string, name: string, color: string): TrackPreset => ({ id, name, color, volume: 0.8, pan: 0, plugins: [], builtin: true });
const DEFAULTS: TrackPreset[] = [
  base("builtin-guitar", "Guitarra", "#f38ba8"),
  base("builtin-bass", "Bajo", "#fab387"),
  base("builtin-drums", "Batería", "#f9e2af"),
  base("builtin-vocal", "Voz", "#a6e3a1"),
];

function load(): TrackPreset[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as TrackPreset[];
    // Lo guardado manda sobre las de fábrica con el mismo nombre
    const names = new Set(saved.map((p) => p.name.toLowerCase()));
    return [...DEFAULTS.filter((d) => !names.has(d.name.toLowerCase())), ...saved];
  } catch {
    return DEFAULTS;
  }
}

function persist(list: TrackPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter((p) => !(p.builtin && DEFAULTS.some((d) => d.id === p.id)))));
  } catch {
    /* sin almacenamiento: las plantillas duran hasta cerrar */
  }
}

export const useTrackPresets = create<{ list: TrackPreset[] }>(() => ({ list: load() }));

/** Guarda la configuración actual de una pista como plantilla (si ya hay una con ese nombre, la sustituye). */
export async function saveTrackPreset(trackId: string) {
  const t = useProject.getState().tracks.find((x) => x.id === trackId);
  if (!t) return;
  let plugins: unknown[] = [];
  if (isTauri()) plugins = await invoke<unknown[]>("plugin_snapshot_track", { track: trackId }).catch(() => []);
  const preset: TrackPreset = {
    id: crypto.randomUUID(),
    name: t.name,
    color: t.color,
    volume: t.volume,
    pan: t.pan,
    input: t.input,
    recordFx: t.recordFx,
    midiPort: t.midiPort,
    plugins,
  };
  const list = [...useTrackPresets.getState().list.filter((p) => p.name.toLowerCase() !== t.name.toLowerCase()), preset];
  useTrackPresets.setState({ list });
  persist(list);
  toast.success(`Plantilla «${t.name}» guardada`);
}

export function deleteTrackPreset(id: string) {
  const list = useTrackPresets.getState().list.filter((p) => p.id !== id);
  useTrackPresets.setState({ list });
  persist(list);
}

/** Crea una pista con la configuración de la plantilla (y sus plugins). */
export async function addTrackFromPreset(p: TrackPreset) {
  const id = useProject.getState().addTrack({
    name: p.name,
    color: p.color,
    volume: p.volume,
    pan: p.pan,
    input: p.input,
    recordFx: p.recordFx,
    midiPort: p.midiPort,
  });
  if (p.plugins.length && isTauri()) {
    const failed = await invoke<string[]>("plugin_apply", { track: id, plugins: p.plugins }).catch((e) => [String(e)]);
    if (failed.length) toast.error(`No se pudieron cargar plugins: ${failed.join("; ")}`);
  }
}
