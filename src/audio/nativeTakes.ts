import * as Tone from "tone";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useProject, type MidiNote } from "@/store/project";
import { subscribeLevels } from "./levels";
import { trackInput } from "./input";
import { useNative } from "./native";

/**
 * Lo que graba el motor nativo durante una toma, además del audio que graba el navegador
 * (src/audio/recorder.ts):
 *   - las notas MIDI de las pistas con instrumento,
 *   - el audio de las pistas de audio (limpio o con efectos) cuando el motor está encendido,
 *     porque entonces la interfaz la tiene abierta él y el navegador puede no poder abrirla,
 *   - el dibujo en vivo de lo que se está grabando.
 * Todo se fecha con el reloj del AudioContext para alinearlo con la línea de tiempo.
 */

/** Cuándo arranca la toma (tiempo del AudioContext). Lo fija el grabador. */
export const takes = { startTime: 0 };

/** Pistas que graba el motor nativo en esta toma. */
export const native = {
  /** Con instrumento: graban notas MIDI. */
  midiTracks: [] as string[],
  /** De audio: graban su señal desde el motor (limpia o con efectos). */
  wetTracks: [] as string[],
};

/** Picos por segundo de la onda en vivo. */
export const LIVE_PEAKS_PER_SEC = 100;

/** Pistas con instrumento que graban MIDI en esta toma (el resto graban audio). */
/** Tiempo del AudioContext en que empezó a anotar el MIDI el motor nativo. */
let midiRef = 0;

/** El motor nativo empieza a anotar las notas de las pistas con instrumento armadas. */
export async function startMidi(trackIds: string[]) {
  native.midiTracks = [];
  if (!isTauri()) return;
  const ctx = Tone.getContext();
  const before = ctx.currentTime;
  native.midiTracks = await invoke<string[]>("midi_record_start", { tracks: trackIds }).catch(() => []);
  // La orden tarda un poco en llegar: se toma el punto medio como instante de salida
  midiRef = (before + ctx.currentTime) / 2;
}

/** Cierra la toma MIDI y la convierte en clips (una copia por pista con instrumento). */
export async function finishMidi(from: number, stopTime: number, take: number, checkpoint: () => void) {
  stopLiveMidi();
  if (!native.midiTracks.length) return;
  const tracks = native.midiTracks;
  native.midiTracks = [];
  const rec = await invoke<{
    tracks: { track: string; notes: { start: number; dur: number; note: number; vel: number; ch: number }[] }[];
  } | null>("midi_record_stop").catch(() => null);
  if (!rec) return;
  // Lo que tocas va acompasado con lo que oyes (el metrónomo sale con la latencia de la salida)
  const raw = Tone.getContext().rawContext as unknown as { baseLatency?: number; outputLatency?: number };
  const lag = (raw.baseLatency ?? 0) + (raw.outputLatency ?? 0);
  const length = Math.max(0, stopTime - takes.startTime);
  const s = useProject.getState();
  for (const trackId of tracks) {
    if (!s.tracks.some((t) => t.id === trackId)) continue;
    const notes: MidiNote[] = [];
    for (const n of rec.tracks.find((t) => t.track === trackId)?.notes ?? []) {
      // Posición de la nota dentro de la toma (s desde que arrancó el transporte)
      const t = midiRef + n.start - takes.startTime - lag;
      if (t < 0 || t >= length) continue;
      notes.push({ t, d: Math.min(n.dur, length - t), n: n.note, v: n.vel, ch: n.ch });
    }
    if (!notes.length) continue;
    checkpoint();
    s.addClip({
      id: crypto.randomUUID(),
      trackId,
      name: `Toma ${take}`,
      start: from,
      offset: 0,
      duration: length,
      sourceDuration: length,
      bufferId: "",
      midi: notes,
    });
  }
}

/**
 * Pistas de audio que graba el motor nativo (la señal limpia de su entrada o, si lo piden,
 * lo que sale de sus plugins). Con el motor encendido es el camino de siempre: la interfaz la
 * tiene abierta él, así que el navegador puede no poder abrirla a la vez.
 */
/** Por pista: true = con efectos, false = limpia. */
const wetMode = new Map<string, boolean>();
let wetRef = 0;

export async function startWet(trackIds: string[]) {
  native.wetTracks = [];
  wetMode.clear();
  if (!isTauri() || useNative.getState().status !== "on") return;
  const { tracks } = useProject.getState();
  const reqs = trackIds
    .filter((id) => !native.midiTracks.includes(id))
    .map((id) => ({ track: id, wet: tracks.find((t) => t.id === id)?.recordFx === true }));
  if (!reqs.length) return;
  const ctx = Tone.getContext();
  const before = ctx.currentTime;
  const accepted = await invoke<[string, boolean][]>("audio_record_start", { tracks: reqs }).catch(() => []);
  for (const [id, wet] of accepted) wetMode.set(id, wet);
  native.wetTracks = accepted.map(([id]) => id);
  wetRef = (before + ctx.currentTime) / 2;
}

/** Cierra la toma nativa y devuelve el audio de cada pista, alineado con la línea de tiempo. */
export async function finishWet(stopTime: number) {
  if (!native.wetTracks.length) return [];
  native.wetTracks = [];
  const bytes = await invoke<ArrayBuffer>("audio_record_stop").catch(() => null);
  if (!bytes) return [];
  const raw = Tone.getContext().rawContext as unknown as { baseLatency?: number; outputLatency?: number };
  const lag = (raw.baseLatency ?? 0) + (raw.outputLatency ?? 0);
  const length = Math.max(0, stopTime - takes.startTime);
  const view = new DataView(bytes);
  const ctx = Tone.getContext();
  const out: { trackId: string; buffer: AudioBuffer; fx: boolean }[] = [];
  let off = 0;
  const count = view.getUint32(off, true);
  off += 4;
  for (let i = 0; i < count; i++) {
    const idLen = view.getUint32(off, true);
    off += 4;
    const trackId = new TextDecoder().decode(new Uint8Array(bytes, off, idLen));
    off += idLen;
    const first = view.getFloat64(off, true);
    off += 8;
    const rate = view.getUint32(off, true);
    off += 4;
    const frames = view.getUint32(off, true);
    off += 4;
    const data = new Float32Array(bytes.slice(off, off + frames * 8));
    off += frames * 8;
    // Dónde cae la primera muestra respecto al inicio de la toma (el metrónomo sale con latencia)
    const shift = Math.round((wetRef + first - takes.startTime - lag) * rate);
    const total = Math.max(1, Math.round(length * rate));
    // Limpia con una sola entrada (1 o 2): mono, como siempre; con efectos o estéreo: estéreo
    const track = useProject.getState().tracks.find((t) => t.id === trackId);
    const mono = wetMode.get(trackId) === false && !!track && trackInput(track) !== "stereo";
    const buffer = ctx.createBuffer(mono ? 1 : 2, total, rate) as unknown as AudioBuffer;
    const l = buffer.getChannelData(0);
    const r = mono ? null : buffer.getChannelData(1);
    for (let k = 0; k < total; k++) {
      const j = k - shift;
      if (j < 0 || j >= frames) continue;
      l[k] = data[j * 2];
      if (r) r[k] = data[j * 2 + 1];
    }
    out.push({ trackId, buffer, fx: wetMode.get(trackId) === true });
  }
  wetMode.clear();
  return out;
}

// --- Onda en vivo de las pistas que graba el motor nativo ---

/** Picos de la toma en curso por pista (a LIVE_PEAKS_PER_SEC), para dibujarla mientras se graba. */
export const livePeaksBy = new Map<string, number[]>();
let unsubLevels: (() => void) | null = null;

export function startLivePeaks() {
  stopLivePeaks();
  const ids = [...native.wetTracks];
  for (const id of ids) livePeaksBy.set(id, []);
  unsubLevels = subscribeLevels(({ peaks }) => {
    const now = Tone.getContext().currentTime - takes.startTime;
    if (now < 0) return; // todavía en la cuenta previa
    const idx = Math.floor(now * LIVE_PEAKS_PER_SEC);
    const { tracks } = useProject.getState();
    for (const id of ids) {
      const arr = livePeaksBy.get(id);
      const track = tracks.find((t) => t.id === id);
      if (!arr || !track) continue;
      const sel = trackInput(track);
      const p = sel === "1" ? peaks[0] : sel === "2" ? peaks[1] : Math.max(peaks[0], peaks[1]);
      while (arr.length <= idx) arr.push(p);
      arr[idx] = Math.max(arr[idx], p);
    }
  });
}

export function stopLivePeaks() {
  unsubLevels?.();
  unsubLevels = null;
  livePeaksBy.clear();
}

// --- Notas MIDI en vivo (para dibujarlas mientras se graba) ---

/** Notas tocadas hasta ahora en esta toma, con el tiempo desde su inicio (s). */
export const liveMidi: MidiNote[] = [];
let liveTimer: ReturnType<typeof setInterval> | null = null;

export function startLiveMidi() {
  stopLiveMidi();
  liveTimer = setInterval(async () => {
    const notes = await invoke<{ start: number; dur: number; note: number; vel: number; ch: number }[]>("midi_record_peek").catch(() => []);
    const raw = Tone.getContext().rawContext as unknown as { baseLatency?: number; outputLatency?: number };
    const lag = (raw.baseLatency ?? 0) + (raw.outputLatency ?? 0);
    liveMidi.length = 0;
    for (const n of notes) {
      const t = midiRef + n.start - takes.startTime - lag;
      if (t >= 0) liveMidi.push({ t, d: n.dur, n: n.note, v: n.vel, ch: n.ch });
    }
  }, 100);
}

export function stopLiveMidi() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  liveMidi.length = 0;
}
