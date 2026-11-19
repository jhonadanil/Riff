import * as Tone from "tone";
import { encodeWav } from "./wav";
import { useProject, type Clip, type LoopRegion, type Track } from "@/store/project";

/**
 * Motor de audio provisional basado en Web Audio (Tone.js).
 * Sirve para prototipar la UI. Más adelante el audio en tiempo real
 * (entrada de guitarra, amplis, VST3/CLAP) vivirá en el backend Rust de Tauri.
 *
 * El estado (pistas, clips) vive en el store de Zustand; este módulo lo observa
 * y mantiene sincronizados los nodos de audio: un Tone.Channel por pista y un
 * Tone.Player (sincronizado con el transporte) por clip.
 */

const transport = () => Tone.getTransport();

// --- Buffers de audio (no van al store: no son serializables) ---------------

const buffers = new Map<string, Tone.ToneAudioBuffer>();
const peaksCache = new Map<string, Float32Array>();

/** Puntos de forma de onda por segundo que se guardan para dibujar. */
const PEAKS_PER_SECOND = 200;

function computePeaks(buffer: AudioBuffer): Float32Array {
  const points = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
  const bucket = Math.max(1, Math.floor(buffer.length / points));
  const peaks = new Float32Array(points);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let p = 0; p < points; p++) {
    let max = 0;
    const from = p * bucket;
    const to = Math.min(from + bucket, buffer.length);
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
    }
    peaks[p] = max;
  }
  return peaks;
}

export function getPeaks(bufferId: string) {
  return peaksCache.get(bufferId);
}

/** Bytes originales de cada audio (para guardarlo en el proyecto tal cual). */
const sources = new Map<string, { bytes: Uint8Array; ext: string }>();

/** Decodifica bytes de audio y los registra con el id dado. */
export async function loadBuffer(bufferId: string, bytes: Uint8Array, ext: string) {
  // decodeAudioData "consume" el ArrayBuffer, así que se decodifica una copia
  const copy = bytes.slice().buffer;
  const audio = await Tone.getContext().decodeAudioData(copy);
  buffers.set(bufferId, new Tone.ToneAudioBuffer(audio));
  peaksCache.set(bufferId, computePeaks(audio));
  sources.set(bufferId, { bytes, ext });
  return audio.duration;
}

/** Decodifica un archivo de audio y lo deja listo para usar en clips. */
export async function decodeFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "wav";
  const bufferId = crypto.randomUUID();
  const duration = await loadBuffer(bufferId, bytes, ext);
  return { bufferId, duration };
}

/** Audio de un buffer listo para escribir a disco (el original o, si no hay, un WAV). */
export function getSource(bufferId: string) {
  const src = sources.get(bufferId);
  if (src) return src;
  const buffer = buffers.get(bufferId)?.get();
  return buffer ? { bytes: encodeWav(buffer), ext: "wav" } : undefined;
}

/** Registra audio grabado (sin archivo original: al guardar se escribe como WAV). */
export function addRecordedBuffer(audio: AudioBuffer) {
  const bufferId = crypto.randomUUID();
  buffers.set(bufferId, new Tone.ToneAudioBuffer(audio));
  peaksCache.set(bufferId, computePeaks(audio));
  return bufferId;
}

export function hasBuffer(bufferId: string) {
  return buffers.has(bufferId);
}

/**
 * Renderiza la mezcla completa (sin tiempo real) y la devuelve como WAV.
 * Reconstruye el grafo de audio en un contexto offline con la misma configuración.
 */
export async function renderMixToWav(onProgress?: (p: number) => void) {
  const { tracks, clips, bpm } = useProject.getState();
  const end = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  if (end <= 0) throw new Error("El proyecto no tiene audio");
  const duration = end + 1; // un segundo de cola

  onProgress?.(0);
  const rendered = await Tone.Offline(({ transport: t }) => {
    t.bpm.value = bpm;
    const chans = new Map<string, Tone.Channel>();
    for (const tr of tracks) {
      const ch = new Tone.Channel({
        channelCount: 2,
        volume: tr.volume <= 0 ? -Infinity : Tone.gainToDb(tr.volume),
        pan: tr.pan,
        mute: tr.muted,
        solo: tr.soloed,
      }).toDestination();
      chans.set(tr.id, ch);
    }
    for (const c of clips) {
      const buffer = buffers.get(c.bufferId);
      const ch = chans.get(c.trackId);
      if (!buffer || !ch) continue;
      new Tone.Player(buffer).connect(ch).sync().start(c.start, c.offset, c.duration);
    }
    t.start(0);
  }, duration, 2);
  onProgress?.(1);

  const audio = rendered.get();
  if (!audio) throw new Error("No se pudo renderizar");
  return encodeWav(audio);
}

// --- Canales (uno por pista) ------------------------------------------------

const channels = new Map<string, Tone.Channel>();

function syncTracks(tracks: Track[]) {
  const ids = new Set(tracks.map((t) => t.id));
  for (const [id, ch] of channels) {
    if (!ids.has(id)) {
      ch.dispose();
      channels.delete(id);
    }
  }
  for (const t of tracks) {
    let ch = channels.get(t.id);
    if (!ch) {
      // Tone.Channel es mono por defecto (channelCount 1): forzar estéreo
      ch = new Tone.Channel({ channelCount: 2 }).toDestination();
      channels.set(t.id, ch);
    }
    ch.volume.value = t.volume <= 0 ? -Infinity : Tone.gainToDb(t.volume);
    ch.pan.value = t.pan;
    ch.mute = t.muted;
    ch.solo = t.soloed;
  }
}

/** Canal de mezcla de una pista (para enrutar la entrada al monitorizar). */
export function trackChannel(trackId: string) {
  return channels.get(trackId);
}

// --- Players (uno por clip) -------------------------------------------------

type PlayerEntry = { player: Tone.Player; key: string };
const players = new Map<string, PlayerEntry>();

/** Todo lo que, si cambia, obliga a reprogramar el clip. */
const clipKey = (c: Clip) => `${c.trackId}|${c.start}|${c.offset}|${c.duration}|${c.bufferId}`;

function syncClips(clips: Clip[]) {
  let changed = false;
  const ids = new Set(clips.map((c) => c.id));
  for (const [id, entry] of players) {
    if (!ids.has(id)) {
      entry.player.unsync().dispose();
      players.delete(id);
      changed = true;
    }
  }
  for (const c of clips) {
    const buffer = buffers.get(c.bufferId);
    const channel = channels.get(c.trackId);
    if (!buffer || !channel) continue;

    const key = clipKey(c);
    const entry = players.get(c.id);
    if (entry?.key === key) continue;

    // Clip nuevo o modificado: (re)crear su player en la posición del transporte
    entry?.player.unsync().dispose();
    const player = new Tone.Player(buffer).connect(channel);
    player.sync().start(c.start, c.offset, c.duration);
    players.set(c.id, { player, key });
    changed = true;
  }
  // Si el transporte ya está sonando, que los cambios se oigan sin esperar al siguiente play
  if (changed && transport().state === "started") restartAtCurrentPosition();
}

function restartAtCurrentPosition() {
  const t = transport();
  t.seconds = t.seconds;
}

// --- Metrónomo -------------------------------------------------------------

const click = new Tone.Synth({
  oscillator: { type: "square" },
  envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.01 },
  volume: -10,
}).toDestination();
let metronomeEvent: number | null = null;

function setMetronome(on: boolean) {
  if (metronomeEvent !== null) transport().clear(metronomeEvent);
  metronomeEvent = null;
  if (!on) return;
  metronomeEvent = transport().scheduleRepeat((time) => {
    // El primer tiempo de cada compás (4/4) suena más agudo
    const beat = Math.round(transport().getTicksAtTime(time) / transport().PPQ) % 4;
    click.triggerAttackRelease(beat === 0 ? "C6" : "G5", 0.03, time);
  }, "4n", 0);
}

/**
 * Cuenta previa: `beats` clics a partir de `time` (tiempo del AudioContext).
 * Usa su propio sintetizador para poder cortarla de golpe si se cancela.
 */
export function countIn(time: number, beats: number, beatSec: number) {
  const synth = new Tone.Synth({
    oscillator: { type: "square" },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.01 },
    volume: -8,
  }).toDestination();
  for (let i = 0; i < beats; i++) synth.triggerAttackRelease(i % 4 === 0 ? "C6" : "G5", 0.03, time + i * beatSec);
  return () => synth.dispose();
}

// --- Loop -------------------------------------------------------------------

function setLoop(loop: LoopRegion | null, enabled: boolean) {
  const t = transport();
  if (loop && enabled && loop.end > loop.start && !recording) {
    t.setLoopPoints(loop.start, loop.end);
    t.loop = true;
  } else {
    t.loop = false;
  }
}

// --- Fin de la canción -------------------------------------------------------

/** Si no hay clips, la reproducción se para al final de la línea de tiempo vacía. */
export const EMPTY_SONG_SEC = 120;
let endEvent: number | null = null;

/** Dónde termina la canción: el final del último clip. */
export function songEnd(clips: Clip[] = useProject.getState().clips) {
  const last = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  return last > 0 ? last : EMPTY_SONG_SEC;
}

/** Programa la parada automática al llegar al final de la canción. */
function scheduleEnd(clips: Clip[]) {
  if (endEvent !== null) transport().clear(endEvent);
  endEvent = null;
  if (recording) return; // grabando, la canción crece: no parar al final
  endEvent = transport().schedule((time) => {
    // Con loop activo dentro de la canción nunca se llega aquí
    transport().pause(time);
    Tone.getDraw().schedule(() => useProject.getState().setPlaying(false), time);
  }, songEnd(clips));
}

// --- Modo grabación ----------------------------------------------------------

/** Mientras se graba no hay loop ni parada al final, y el cursor no se puede mover. */
let recording = false;

export function setRecordingMode(on: boolean) {
  recording = on;
  const s = useProject.getState();
  setLoop(s.loop, s.loopEnabled);
  scheduleEnd(s.clips);
}

// Mantener el audio en sincronía con el store
{
  const s = useProject.getState();
  syncTracks(s.tracks);
  syncClips(s.clips);
  transport().bpm.value = s.bpm;
  setMetronome(s.metronome);
  setLoop(s.loop, s.loopEnabled);
  scheduleEnd(s.clips);
}
useProject.subscribe((state, prev) => {
  if (state.tracks !== prev.tracks) syncTracks(state.tracks);
  if (state.clips !== prev.clips || state.tracks !== prev.tracks) syncClips(state.clips);
  if (state.clips !== prev.clips) scheduleEnd(state.clips);
  if (state.bpm !== prev.bpm) transport().bpm.value = state.bpm;
  if (state.metronome !== prev.metronome) setMetronome(state.metronome);
  if (state.loop !== prev.loop || state.loopEnabled !== prev.loopEnabled) setLoop(state.loop, state.loopEnabled);
});

// --- Transporte -------------------------------------------------------------

let started = false;

export async function ensureAudioStarted() {
  if (!started) {
    await Tone.start();
    started = true;
  }
}

export async function play() {
  await ensureAudioStarted();
  // Si el cursor está al final (o más allá), volver a empezar desde el principio
  if (transport().seconds >= songEnd() - 0.05) seek(0);
  transport().start();
}

/** Pausa: la posición se mantiene donde está. */
export function pause() {
  transport().pause();
}

const seekListeners = new Set<(seconds: number) => void>();

/** Avisa cada vez que el cursor salta (p. ej. para que la vista lo siga). */
export function onSeek(fn: (seconds: number) => void) {
  seekListeners.add(fn);
  return () => void seekListeners.delete(fn);
}

/** Mueve el cursor de reproducción (en segundos). */
export function seek(seconds: number) {
  if (recording) return;
  transport().seconds = Math.max(0, seconds);
  seekListeners.forEach((fn) => fn(Math.max(0, seconds)));
}

/** Arranca el transporte en `time` (AudioContext) desde la posición `offset` (s). */
export function startAt(time: number, offset: number) {
  transport().start(time, Math.max(0, offset));
}

/** Posición del transporte (s) que corresponde a un instante del AudioContext. */
export function positionAtTime(time: number) {
  return transport().getSecondsAtTime(time);
}

/** Posición actual del transporte en segundos. */
export function position() {
  return transport().seconds;
}
