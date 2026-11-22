import { invoke, isTauri } from "@tauri-apps/api/core";
import { midiNotesByTrack } from "./midiNotes";
import * as Tone from "tone";
import { encodeWav } from "./wav";
import { useProject, type Clip, type LoopRegion } from "@/store/project";
import { audibility, autoValue, bakeClip, dbOf, hasEnvelope, peakMeter, peakOf, trackAutomation, type PeakMeter } from "./mix";

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
  const { tracks, clips, bpm, buses, master } = useProject.getState();
  const end = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  if (end <= 0) throw new Error("El proyecto no tiene audio");
  const duration = end + 1; // un segundo de cola
  const { trackAudible, busAudible } = audibility(tracks, buses);

  // Clips con ganancia o fundidos: se hornean aparte (suenan enteros desde 0)
  const baked = new Map<string, Tone.ToneAudioBuffer>();
  for (const c of clips) {
    const src = buffers.get(c.bufferId)?.get();
    if (src && hasEnvelope(c)) baked.set(c.id, new Tone.ToneAudioBuffer(bakeClip(src, c)));
  }

  onProgress?.(0);
  const instruments = await renderInstruments(clips, duration);
  const rendered = await Tone.Offline(({ transport: t }) => {
    t.bpm.value = bpm;
    const out = new Tone.Channel({ channelCount: 2, volume: dbOf(master) }).toDestination();
    const busChans = new Map<string, Tone.Channel>();
    for (const b of buses) {
      const ch = new Tone.Channel({ channelCount: 2, volume: dbOf(b.volume), pan: b.pan, mute: !busAudible.get(b.id) });
      ch.connect(out);
      busChans.set(b.id, ch);
    }
    const chans = new Map<string, Tone.Channel>();
    for (const tr of tracks) {
      const ch = new Tone.Channel({ channelCount: 2, volume: dbOf(tr.volume), pan: tr.pan, mute: !trackAudible.get(tr.id) });
      ch.connect((tr.out ? busChans.get(tr.out) : undefined) ?? out);
      for (const [busId, level] of Object.entries(tr.sends ?? {})) {
        const bus = busChans.get(busId);
        if (!bus || level <= 0) continue;
        const send = new Tone.Gain(level);
        ch.connect(send);
        send.connect(bus);
      }
      const auto = trackAutomation(tr);
      if (auto) {
        for (let at = 0; at <= duration; at += AUTOMATION_STEP) {
          if (auto.volume) ch.volume.setValueAtTime(Math.max(-100, dbOf(autoValue(auto.volume, at, tr.volume))), at);
          if (auto.pan) ch.pan.setValueAtTime(autoValue(auto.pan, at, tr.pan), at);
        }
      }
      chans.set(tr.id, ch);
    }
    for (const c of clips) {
      const buffer = buffers.get(c.bufferId);
      const ch = chans.get(c.trackId);
      if (!buffer || !ch) continue;
      const bake = baked.get(c.id);
      if (bake) new Tone.Player(bake).connect(ch).sync().start(c.start, 0, c.duration);
      else new Tone.Player(buffer).connect(ch).sync().start(c.start, c.offset, c.duration);
    }
    // Instrumentos ya renderizados por el motor nativo: entran por el canal de su pista
    for (const [trackId, buffer] of instruments) {
      const ch = chans.get(trackId);
      if (ch) new Tone.Player(buffer).connect(ch).start(0);
    }
    t.start(0);
  }, duration, 2);
  onProgress?.(1);

  const audio = rendered.get();
  if (!audio) throw new Error("No se pudo renderizar");
  return encodeWav(audio);
}

/** Cada cuántos segundos se muestrea una envolvente al exportar y al sonar. */
const AUTOMATION_STEP = 0.02;

/**
 * Toca los clips MIDI por los instrumentos (motor nativo, sin tiempo real) y devuelve el
 * audio de cada pista. Si no se puede (fuera de la app de escritorio, sin plugins), se omiten.
 */
async function renderInstruments(clips: Clip[], duration: number) {
  const out = new Map<string, AudioBuffer>();
  if (!isTauri()) return out;
  const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext;
  for (const [trackId, notes] of Object.entries(midiNotesByTrack(clips))) {
    if (!notes.length) continue;
    try {
      const bytes = await invoke<ArrayBuffer>("plugin_render", { track: trackId, clips: notes, duration });
      out.set(trackId, await ctx.decodeAudioData(bytes));
    } catch (err) {
      // Una pista MIDI sin instrumento cargado no suena: no debe impedir exportar el resto
      console.warn("[exportar] no se pudo renderizar el instrumento de la pista", trackId, err);
    }
  }
  return out;
}

// --- Canales: pistas, buses y master -----------------------------------------

/** Salida final de la mezcla: todo pasa por aquí antes de llegar a los altavoces. */
const master = new Tone.Channel({ channelCount: 2 }).toDestination();
const channels = new Map<string, Tone.Channel>();
const busChannels = new Map<string, Tone.Channel>();

/** A dónde va cada pista: su salida y los envíos a buses. */
type Route = { out: Tone.Channel; sends: Map<string, { gain: Tone.Gain; bus: Tone.Channel }> };
const routes = new Map<string, Route>();
const meters = new Map<string, PeakMeter>();

function dropMeter(id: string) {
  meters.get(id)?.dispose();
  meters.delete(id);
}

/** Medidor de pico de una pista, un bus o el master ("master"). Se crea al pedirlo. */
export function meterOf(id: string) {
  let m = meters.get(id);
  if (!m) {
    const node = id === "master" ? master : (channels.get(id) ?? busChannels.get(id));
    if (!node) return undefined;
    m = peakMeter(node);
    meters.set(id, m);
  }
  return m;
}

const newChannel = () => new Tone.Channel({ channelCount: 2 }); // Tone.Channel es mono por defecto

function syncMix() {
  const { tracks, buses, master: masterVolume } = useProject.getState();
  master.volume.value = dbOf(masterVolume);
  const { trackAudible, busAudible } = audibility(tracks, buses);

  // Buses (primero, para que las pistas puedan colgar de ellos)
  const busIds = new Set(buses.map((b) => b.id));
  for (const b of buses) {
    let ch = busChannels.get(b.id);
    if (!ch) {
      ch = newChannel().connect(master);
      busChannels.set(b.id, ch);
    }
    ch.volume.value = dbOf(b.volume);
    ch.pan.value = b.pan;
    ch.mute = !busAudible.get(b.id);
  }

  const ids = new Set(tracks.map((t) => t.id));
  for (const [id, ch] of channels) {
    if (ids.has(id)) continue;
    const r = routes.get(id);
    r?.sends.forEach((s) => s.gain.dispose());
    routes.delete(id);
    dropMeter(id);
    ch.dispose();
    channels.delete(id);
  }

  for (const t of tracks) {
    let ch = channels.get(t.id);
    let route = routes.get(t.id);
    if (!ch || !route) {
      ch = newChannel();
      ch.connect(master);
      channels.set(t.id, ch);
      route = { out: master, sends: new Map() };
      routes.set(t.id, route);
    }
    ch.volume.value = dbOf(t.volume);
    ch.pan.value = t.pan;
    ch.mute = !trackAudible.get(t.id);

    // Salida: master o un bus
    const out = (t.out && busChannels.get(t.out)) || master;
    if (route.out !== out) {
      ch.disconnect(route.out);
      ch.connect(out);
      route.out = out;
    }
    // Envíos
    for (const [busId, send] of route.sends) {
      if ((t.sends?.[busId] ?? 0) <= 0 || !busIds.has(busId) || busChannels.get(busId) !== send.bus) {
        send.gain.dispose();
        route.sends.delete(busId);
      }
    }
    for (const [busId, level] of Object.entries(t.sends ?? {})) {
      const bus = busChannels.get(busId);
      if (!bus || level <= 0) continue;
      let send = route.sends.get(busId);
      if (!send) {
        const gain = new Tone.Gain(level);
        ch.connect(gain);
        gain.connect(bus);
        send = { gain, bus };
        route.sends.set(busId, send);
      }
      send.gain.gain.value = level;
    }
  }

  // Buses que ya no existen (al final: sus envíos ya se han soltado)
  for (const [id, ch] of busChannels) {
    if (busIds.has(id)) continue;
    dropMeter(id);
    ch.dispose();
    busChannels.delete(id);
  }
}

/** Canal de mezcla de una pista (para enrutar la entrada al monitorizar). */
export function trackChannel(trackId: string) {
  return channels.get(trackId);
}

// --- Automatización en vivo ---------------------------------------------------

let automationApplied = false;

/** Mientras suena, los fader y el pan de las pistas con envolvente siguen la envolvente. */
function applyAutomation() {
  const t = transport();
  if (t.state !== "started") {
    // Al parar, volver a lo que marcan los faders
    if (automationApplied) {
      automationApplied = false;
      syncMix();
    }
    return;
  }
  const pos = t.seconds;
  for (const tr of useProject.getState().tracks) {
    const auto = trackAutomation(tr);
    const ch = channels.get(tr.id);
    if (!auto || !ch) continue;
    automationApplied = true;
    if (auto.volume) ch.volume.rampTo(Math.max(-100, dbOf(autoValue(auto.volume, pos, tr.volume))), 0.03);
    if (auto.pan) ch.pan.rampTo(autoValue(auto.pan, pos, tr.pan), 0.03);
  }
}
setInterval(applyAutomation, 30);

// --- Players (uno por clip) -------------------------------------------------

type PlayerEntry = { player: Tone.Player; key: string };
const players = new Map<string, PlayerEntry>();

/** Todo lo que, si cambia, obliga a reprogramar el clip. */
const clipKey = (c: Clip) =>
  `${c.trackId}|${c.start}|${c.offset}|${c.duration}|${c.bufferId}|${c.gain ?? 1}|${c.fadeIn ?? 0}|${c.fadeOut ?? 0}`;

/** Pico (0..1+) de la parte audible de un clip de audio; undefined si no hay audio. */
export function clipPeak(clip: Clip) {
  const b = buffers.get(clip.bufferId)?.get();
  return b ? peakOf(b, clip.offset, clip.duration) : undefined;
}

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
    // Con ganancia o fundidos, el clip suena ya recortado y procesado desde su principio
    const baked = hasEnvelope(c) ? new Tone.ToneAudioBuffer(bakeClip(buffer.get()!, c)) : null;
    const player = new Tone.Player(baked ?? buffer).connect(channel);
    player.sync().start(c.start, baked ? 0 : c.offset, c.duration);
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

function setMetronome() {
  if (metronomeEvent !== null) transport().clear(metronomeEvent);
  metronomeEvent = null;
  const { metronome, timeSig, click: prefs } = useProject.getState();
  click.volume.value = prefs.volume;
  if (!metronome) return;
  const [beats, unit] = timeSig;
  const t = transport();
  // Un click por tiempo (o por mitad de tiempo con subdivisión)
  const beatTicks = (t.PPQ * 4) / unit;
  const step = prefs.eighths ? beatTicks / 2 : beatTicks;
  metronomeEvent = t.scheduleRepeat((time) => {
    const n = Math.round(t.getTicksAtTime(time) / step);
    if (prefs.eighths && n % 2 === 1) {
      click.triggerAttackRelease("E5", 0.02, time, 0.4);
      return;
    }
    const beat = (prefs.eighths ? n / 2 : n) % beats;
    // El primer tiempo de cada compás suena más agudo
    click.triggerAttackRelease(beat === 0 ? "C6" : "G5", 0.03, time);
  }, `${step}i`, 0);
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
  for (let i = 0; i < beats; i++) synth.triggerAttackRelease(i === 0 ? "C6" : "G5", 0.03, time + i * beatSec);
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
  syncMix();
  syncClips(s.clips);
  transport().bpm.value = s.bpm;
  setMetronome();
  setLoop(s.loop, s.loopEnabled);
  scheduleEnd(s.clips);
}
useProject.subscribe((state, prev) => {
  if (state.tracks !== prev.tracks || state.buses !== prev.buses || state.master !== prev.master) syncMix();
  if (state.clips !== prev.clips || state.tracks !== prev.tracks || state.buses !== prev.buses) syncClips(state.clips);
  if (state.clips !== prev.clips) scheduleEnd(state.clips);
  if (state.bpm !== prev.bpm) transport().bpm.value = state.bpm;
  if (state.metronome !== prev.metronome || state.timeSig !== prev.timeSig || state.click !== prev.click) {
    setMetronome();
    // Solo un cambio de compás reinicia el transporte; el volumen y la subdivisión se aplican sin cortar nada
    if (state.metronome && state.timeSig !== prev.timeSig && transport().state === "started") restartAtCurrentPosition();
  }
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

/** Lo que le pasa al transporte (para el secuenciador MIDI, que va por otro camino de audio). */
export type TransportEvent = { type: "start" | "stop"; position: number; delay: number };
const transportListeners = new Set<(e: TransportEvent) => void>();

export function onTransport(fn: (e: TransportEvent) => void) {
  transportListeners.add(fn);
  return () => void transportListeners.delete(fn);
}

{
  const emit = (e: TransportEvent) => transportListeners.forEach((fn) => fn(e));
  // Segundos que faltan para que ocurra algo programado en el tiempo del AudioContext
  const wait = (time: number) => Math.max(0, time - Tone.getContext().currentTime);
  const t = transport();
  // Arrancar (o saltar, que Tone lo hace como parar y arrancar) y volver al principio del loop
  t.on("start", (time: number, offset: number) => emit({ type: "start", position: offset, delay: wait(time) }));
  t.on("loopStart", (time: number, seconds: number) => emit({ type: "start", position: seconds, delay: wait(time) }));
  t.on("stop", () => emit({ type: "stop", position: 0, delay: 0 }));
  t.on("pause", () => emit({ type: "stop", position: 0, delay: 0 }));
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
