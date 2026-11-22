import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Qué lleva cada pista (nº de plugins y si el primero es un instrumento).
 * Una pista con instrumento es de MIDI: toca notas en vez de recibir audio de la interfaz.
 */

export type TrackKind = "audio" | "midi";
type Chains = {
  /** Por pista: plugins que lleva y si el primero es un instrumento. */
  byTrack: Record<string, { count: number; instrument: boolean }>;
};

export const useChains = create<Chains>(() => ({ byTrack: {} }));

/** Vuelve a leer las cadenas del motor (tras añadir, quitar o reordenar plugins). */
export async function refreshChains() {
  if (!isTauri()) return;
  const raw = await invoke<Record<string, [number, boolean]>>("plugin_overview").catch(() => null);
  if (!raw) return;
  const byTrack: Chains["byTrack"] = {};
  for (const [id, [count, instrument]] of Object.entries(raw)) byTrack[id] = { count, instrument };
  // No avisar si no ha cambiado nada
  const prev = useChains.getState().byTrack;
  const same =
    Object.keys(byTrack).length === Object.keys(prev).length &&
    Object.entries(byTrack).every(([id, v]) => prev[id]?.count === v.count && prev[id]?.instrument === v.instrument);
  if (!same) useChains.setState({ byTrack });
}

/** Si la pista es de audio (entrada de la interfaz) o de MIDI (lleva un instrumento). */
export function useTrackKind(trackId: string): TrackKind {
  return useChains((s) => (s.byTrack[trackId]?.instrument ? "midi" : "audio"));
}

export function useTrackPluginCount(trackId: string) {
  return useChains((s) => s.byTrack[trackId]?.count ?? 0);
}

if (isTauri()) {
  void refreshChains();
  // Por si cambia desde otro sitio (abrir un proyecto, deshacer…)
  setInterval(() => void refreshChains(), 2000);
}
