import type { Clip } from "@/store/project";

export type AbsNote = { start: number; dur: number; note: number; vel: number; ch: number };

/** Notas de todos los clips MIDI por pista, con tiempos absolutos en la línea de tiempo (s). */
export function midiNotesByTrack(clips: Clip[]) {
  const byTrack: Record<string, AbsNote[]> = {};
  for (const c of clips) {
    if (!c.midi) continue;
    const list = (byTrack[c.trackId] ??= []);
    for (const n of c.midi) {
      // Solo lo que cae dentro de la parte visible del clip (recortado)
      if (n.t < c.offset || n.t >= c.offset + c.duration) continue;
      const dur = Math.min(n.d, c.offset + c.duration - n.t);
      list.push({ start: c.start + n.t - c.offset, dur, note: n.n, vel: n.v, ch: n.ch });
    }
  }
  return byTrack;
}
