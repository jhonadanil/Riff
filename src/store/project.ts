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
  start: number;
  duration: number;
  /** Referencia al audio decodificado que guarda el motor (src/audio/engine.ts). */
  bufferId: string;
};

export const MIN_ZOOM = 10; // px por segundo
export const MAX_ZOOM = 400;

type ProjectState = {
  bpm: number;
  isPlaying: boolean;
  isRecording: boolean;
  tracks: Track[];
  clips: Clip[];
  selectedTrackId: string | null;
  /** Zoom horizontal de la línea de tiempo, en píxeles por segundo. */
  pxPerSec: number;
  setBpm: (bpm: number) => void;
  setPlaying: (v: boolean) => void;
  toggleRecording: () => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  selectTrack: (id: string) => void;
  addClip: (clip: Clip) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  setZoom: (pxPerSec: number) => void;
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

export const useProject = create<ProjectState>((set) => ({
  bpm: 120,
  isPlaying: false,
  isRecording: false,
  tracks: [
    track("gtr-l", "Guitarra L", "oklch(0.70 0.18 35)", -0.6),
    track("gtr-r", "Guitarra R", "oklch(0.72 0.17 60)", 0.6),
    track("bass", "Bajo", "oklch(0.65 0.15 260)"),
    track("drums", "Batería", "oklch(0.72 0.14 150)"),
    track("vox", "Voz", "oklch(0.75 0.15 320)"),
  ],
  clips: [],
  selectedTrackId: "gtr-l",
  pxPerSec: 50,
  setBpm: (bpm) => set({ bpm }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  toggleRecording: () => set((s) => ({ isRecording: !s.isRecording })),
  updateTrack: (id, patch) =>
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  selectTrack: (selectedTrackId) => set({ selectedTrackId }),
  addClip: (clip) => set((s) => ({ clips: [...s.clips, clip] })),
  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeClip: (id) => set((s) => ({ clips: s.clips.filter((c) => c.id !== id) })),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSec)) }),
}));
