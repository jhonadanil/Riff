import * as Tone from "tone";
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

/** Decodifica un archivo de audio y lo deja listo para usar en clips. */
export async function decodeFile(file: File) {
  const data = await file.arrayBuffer();
  const audio = await Tone.getContext().decodeAudioData(data);
  const id = crypto.randomUUID();
  buffers.set(id, new Tone.ToneAudioBuffer(audio));
  peaksCache.set(id, computePeaks(audio));
  return { bufferId: id, duration: audio.duration };
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
      ch = new Tone.Channel().toDestination();
      channels.set(t.id, ch);
    }
    ch.volume.value = t.volume <= 0 ? -Infinity : Tone.gainToDb(t.volume);
    ch.pan.value = t.pan;
    ch.mute = t.muted;
    ch.solo = t.soloed;
  }
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

// --- Loop -------------------------------------------------------------------

function setLoop(loop: LoopRegion | null, enabled: boolean) {
  const t = transport();
  if (loop && enabled && loop.end > loop.start) {
    t.setLoopPoints(loop.start, loop.end);
    t.loop = true;
  } else {
    t.loop = false;
  }
}

// Mantener el audio en sincronía con el store
{
  const s = useProject.getState();
  syncTracks(s.tracks);
  syncClips(s.clips);
  transport().bpm.value = s.bpm;
  setMetronome(s.metronome);
  setLoop(s.loop, s.loopEnabled);
}
useProject.subscribe((state, prev) => {
  if (state.tracks !== prev.tracks) syncTracks(state.tracks);
  if (state.clips !== prev.clips || state.tracks !== prev.tracks) syncClips(state.clips);
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
  transport().start();
}

/** Pausa: la posición se mantiene donde está. */
export function pause() {
  transport().pause();
}

/** Mueve el cursor de reproducción (en segundos). */
export function seek(seconds: number) {
  transport().seconds = Math.max(0, seconds);
}

/** Posición actual del transporte en segundos. */
export function position() {
  return transport().seconds;
}
