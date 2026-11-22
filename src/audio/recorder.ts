import * as Tone from "tone";
import { create } from "zustand";
import { toast } from "sonner";
import { beatSeconds, useProject } from "@/store/project";
import * as engine from "./engine";
import { invoke } from "@tauri-apps/api/core";
import { inputNode, recordingLatencyMs, trackInput, useInput, waitForInput } from "./input";
import {
  finishMidi,
  finishWet,
  LIVE_PEAKS_PER_SEC,
  native,
  startLiveMidi,
  startLivePeaks,
  startMidi,
  startWet,
  stopLiveMidi,
  stopLivePeaks,
  takes,
} from "./nativeTakes";

/**
 * Grabación desde la entrada de audio a las pistas armadas.
 *
 *   entrada → AudioWorklet (copia las muestras tal cual) → hilo principal
 *
 * El worklet anota el número de muestra (currentFrame) de cada bloque, así
 * que la toma se puede alinear con la línea de tiempo con precisión de una
 * muestra: se recorta todo lo anterior al instante en que arranca el transporte.
 */

type Phase = "idle" | "starting" | "countin" | "recording" | "finishing";

type RecorderState = {
  phase: Phase;
  /** Posición de la línea de tiempo donde empieza la toma (s). */
  start: number;
  /** Pistas que reciben la toma. */
  trackIds: string[];
};

export const useRecorder = create<RecorderState>(() => ({ phase: "idle", start: 0, trackIds: [] }));

// --- Worklet de captura ------------------------------------------------------

/** Muestras por mensaje al hilo principal (~85 ms a 48 kHz). */
const FLUSH_FRAMES = 4096;

const WORKLET = /* js */ `
class RiffRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunks = [];
    this.frames = 0;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.on = true;
        this.chunks = [];
        this.frames = 0;
      } else if (e.data === "stop") {
        this.flush();
        this.on = false;
        this.port.postMessage({ type: "done" });
      }
    };
  }
  flush() {
    if (!this.chunks.length) return;
    const n = this.chunks.reduce((m, c) => Math.max(m, c.length), 1);
    const channels = [];
    for (let c = 0; c < n; c++) {
      const data = new Float32Array(this.frames);
      let at = 0;
      for (const chunk of this.chunks) {
        data.set(chunk[c] || chunk[0], at);
        at += chunk[0].length;
      }
      channels.push(data);
    }
    this.port.postMessage({ type: "data", frame: this.first, channels }, channels.map((d) => d.buffer));
    this.chunks = [];
    this.frames = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const chans = input && input.length ? input.map((d) => d.slice()) : [new Float32Array(128)];
    if (!this.chunks.length) this.first = currentFrame;
    this.chunks.push(chans);
    this.frames += chans[0].length;
    if (this.frames >= ${FLUSH_FRAMES}) this.flush();
    return true;
  }
}
registerProcessor("riff-recorder", RiffRecorder);
`;

type Segment = { frame: number; channels: Float32Array[] };

let node: AudioWorkletNode | null = null;
let segments: Segment[] = [];
let onDone: (() => void) | null = null;

/** Picos de la toma en curso para dibujarla mientras se graba. */
export const livePeaks: number[] = [];
/** Muestra (del AudioContext) en la que arranca el transporte al grabar. */
let startFrame = 0;
/**
 * Muestra donde empieza de verdad la toma: lo tocado al ritmo de `startFrame`
 * llega tarde por la latencia, así que se toma el audio desplazado.
 */
let captureFrame = 0;

async function ensureNode() {
  if (node) return node;
  const ctx = Tone.getContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.addAudioWorkletModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const n = ctx.createAudioWorkletNode("riff-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  n.port.onmessage = (e: MessageEvent) => {
    if (e.data.type === "data") {
      const seg = e.data as Segment;
      segments.push(seg);
      addLivePeaks(seg);
    } else if (e.data.type === "done") {
      onDone?.();
      onDone = null;
    }
  };
  // Un worklet solo procesa si alguien "tira" de su salida: va a un nodo mudo
  const sink = new Tone.Gain(0).toDestination();
  Tone.connect(n, sink);
  Tone.connect(inputNode(), n);
  node = n as unknown as AudioWorkletNode;
  return node;
}

function addLivePeaks(seg: Segment) {
  const sr = Tone.getContext().sampleRate;
  const per = Math.max(1, Math.round(sr / LIVE_PEAKS_PER_SEC));
  const len = seg.channels[0].length;
  for (let i = 0; i < len; i++) {
    const frame = seg.frame + i;
    if (frame < captureFrame) continue;
    const p = Math.floor((frame - captureFrame) / per);
    let v = 0;
    for (const ch of seg.channels) v = Math.max(v, Math.abs(ch[i]));
    if (p >= livePeaks.length) livePeaks.push(v);
    else if (v > livePeaks[p]) livePeaks[p] = v;
  }
}

// --- Grabar / parar ----------------------------------------------------------

let cancelCountIn: (() => void) | null = null;
let startTimer: ReturnType<typeof setTimeout> | null = null;
/** Tiempo del AudioContext en que arranca la toma (para la cuenta atrás). */
let beatSec = 0.5;

/** Un solo paso de deshacer por toma, sin importar cuántos clips (MIDI, con efectos, limpios) cree. */
let checkpointed = false;
function checkpointOnce() {
  if (checkpointed) return;
  checkpointed = true;
  useProject.getState().checkpoint();
}

/** Pistas que van a grabar; si no hay ninguna armada, se arma la seleccionada. */
function targetTracks() {
  const s = useProject.getState();
  const armed = s.tracks.filter((t) => t.armed);
  if (armed.length) return armed.map((t) => t.id);
  const t = s.tracks.find((t) => t.id === s.selectedTrackId) ?? s.tracks[0];
  if (!t) return [];
  s.updateTrack(t.id, { armed: true });
  toast(`Pista «${t.name}» armada para grabar`);
  return [t.id];
}

/** R: empieza a grabar o, si ya se está grabando, para. */
export async function toggleRecord() {
  const { phase } = useRecorder.getState();
  if (phase === "idle") await startRecording();
  else if (phase === "countin" || phase === "recording") await stopRecording();
}

export async function startRecording() {
  if (useRecorder.getState().phase !== "idle") return;
  const trackIds = targetTracks();
  if (!trackIds.length) return;
  useRecorder.setState({ phase: "starting", trackIds });

  try {
    await engine.ensureAudioStarted();
    // Las pistas con instrumento graban MIDI; las demás, audio de la entrada
    await startMidi(trackIds);
    if (native.midiTracks.length) startLiveMidi();
    await startWet(trackIds);
    if (native.wetTracks.length) startLivePeaks();
    const audioIds = trackIds.filter((id) => !native.midiTracks.includes(id) && !native.wetTracks.includes(id));
    if (audioIds.length && !(await waitForInput())) {
      void invoke("midi_record_stop").catch(() => null);
      if (native.wetTracks.length) void invoke("audio_record_stop").catch(() => null);
      native.midiTracks = [];
      native.wetTracks = [];
      const { error, setPanelOpen } = useInput.getState();
      toast.error("No se puede grabar: la entrada de audio no está disponible", {
        description: error ?? undefined,
        action: { label: "Configurar", onClick: () => setPanelOpen(true) },
      });
      useRecorder.setState({ phase: "idle", trackIds: [] });
      return;
    }
    const n = audioIds.length ? await ensureNode() : null;

    const ctx = Tone.getContext();
    const { isPlaying, countIn, bpm, timeSig, setPlaying } = useProject.getState();
    segments = [];
    livePeaks.length = 0;
    engine.setRecordingMode(true);
    const latencyFrames = Math.round((recordingLatencyMs().total / 1000) * ctx.sampleRate);

    if (isPlaying) {
      // Ya sonando: grabar desde ya, sin cuenta previa
      takes.startTime = ctx.currentTime;
      startFrame = Math.round(takes.startTime * ctx.sampleRate);
      captureFrame = startFrame + latencyFrames;
      n?.port.postMessage("start");
      useRecorder.setState({ phase: "recording", start: engine.positionAtTime(takes.startTime) });
      return;
    }

    const from = engine.position();
    beatSec = beatSeconds(bpm, timeSig);
    // La cuenta previa dura un compás
    const beats = countIn ? timeSig[0] : 0;
    const t0 = ctx.currentTime + 0.15;
    takes.startTime = t0 + beats * beatSec;
    startFrame = Math.round(takes.startTime * ctx.sampleRate);
    captureFrame = startFrame + latencyFrames;
    n?.port.postMessage("start"); // lo anterior a startFrame se descarta al final
    if (beats) cancelCountIn = engine.countIn(t0, beats, beatSec);
    useRecorder.setState({ phase: beats ? "countin" : "recording", start: from });

    // El transporte se programa justo antes de que acabe la cuenta, para poder cancelarla
    const arm = () => {
      startTimer = null;
      engine.startAt(takes.startTime, from);
      setPlaying(true);
      const wait = Math.max(0, (takes.startTime - Tone.getContext().currentTime) * 1000);
      setTimeout(() => {
        if (useRecorder.getState().phase === "countin") useRecorder.setState({ phase: "recording" });
      }, wait);
    };
    const lead = (takes.startTime - ctx.currentTime - 0.1) * 1000;
    if (lead > 0) startTimer = setTimeout(arm, lead);
    else arm();
  } catch (err) {
    console.error(err);
    toast.error("No se pudo empezar a grabar", { description: err instanceof Error ? err.message : String(err) });
    abort();
  }
}

/** Deja todo como antes de grabar, sin crear clips. */
function abort() {
  if (startTimer) clearTimeout(startTimer);
  startTimer = null;
  cancelCountIn?.();
  cancelCountIn = null;
  node?.port.postMessage("stop");
  stopLiveMidi();
  stopLivePeaks();
  if (native.midiTracks.length) void invoke("midi_record_stop").catch(() => null);
  native.midiTracks = [];
  if (native.wetTracks.length) void invoke("audio_record_stop").catch(() => null);
  native.wetTracks = [];
  onDone = null;
  segments = [];
  livePeaks.length = 0;
  engine.setRecordingMode(false);
  useRecorder.setState({ phase: "idle", trackIds: [] });
}

export async function stopRecording() {
  const { phase, start, trackIds } = useRecorder.getState();
  if (phase === "idle" || phase === "starting" || phase === "finishing") return;

  const ctx = Tone.getContext();
  const stopTime = ctx.currentTime;
  engine.pause();
  useProject.getState().setPlaying(false);

  // Cancelada durante la cuenta previa: no hay toma
  if (phase === "countin" || stopTime <= takes.startTime) {
    abort();
    return;
  }

  useRecorder.setState({ phase: "finishing" });
  cancelCountIn?.();
  cancelCountIn = null;
  const audioIds = trackIds.filter((id) => !native.midiTracks.includes(id) && !native.wetTracks.includes(id));
  if (audioIds.length) {
    await new Promise<void>((resolve) => {
      onDone = resolve;
      node!.port.postMessage("stop");
    });
  }
  engine.setRecordingMode(false);
  checkpointed = false;
  const take = useProject.getState().clips.filter((c) => /^Toma \d+$/.test(c.name)).length + 1;
  await finishMidi(start, stopTime, take, checkpointOnce);
  const wet = await finishWet(stopTime);
  stopLivePeaks();

  // Lo que suena hasta stopTime entra `latencia` más tarde: se toma ese mismo tramo desplazado
  const stopFrame = Math.round(stopTime * ctx.sampleRate);
  const audio = audioIds.length
    ? assemble(captureFrame, Math.max(captureFrame, stopFrame - Math.max(0, startFrame - captureFrame)))
    : null;
  segments = [];
  livePeaks.length = 0;
  useRecorder.setState({ phase: "idle", trackIds: [] });
  if (wet.length) {
    const s = useProject.getState();
    checkpointOnce();
    for (const { trackId, buffer } of wet) {
      if (!s.tracks.some((t) => t.id === trackId)) continue;
      s.addClip({
        id: crypto.randomUUID(),
        trackId,
        name: `Toma ${take}`,
        start,
        offset: 0,
        duration: buffer.duration,
        sourceDuration: buffer.duration,
        bufferId: engine.addRecordedBuffer(buffer),
      });
    }
  }
  if (!audio) {
    // Solo MIDI o solo con efectos: el cursor vuelve a donde empezó la toma
    engine.seek(start);
    return;
  }

  // Cada pista se queda con la entrada que tiene elegida: una sola entrada o las dos
  const made = new Map<string, { id: string; duration: number }>();
  const bufferFor = (sel: "1" | "2" | "stereo") => {
    let m = made.get(sel);
    if (!m) {
      let buf = audio;
      if (sel !== "stereo" && audio.numberOfChannels > 1) {
        buf = Tone.getContext().createBuffer(1, audio.length, audio.sampleRate) as unknown as AudioBuffer;
        buf.copyToChannel(audio.getChannelData(sel === "2" ? 1 : 0), 0);
      }
      m = { id: engine.addRecordedBuffer(buf), duration: buf.duration };
      made.set(sel, m);
    }
    return m;
  };
  const s = useProject.getState();
  checkpointOnce();
  for (const trackId of audioIds) {
    const track = s.tracks.find((t) => t.id === trackId);
    if (!track) continue;
    const buf = bufferFor(trackInput(track));
    s.addClip({
      id: crypto.randomUUID(),
      trackId,
      name: `Toma ${take}`,
      start,
      offset: 0,
      duration: buf.duration,
      sourceDuration: buf.duration,
      bufferId: buf.id,
    });
  }
  // El cursor vuelve a donde empezó la toma, listo para escucharla
  engine.seek(start);
}

/** Junta los bloques recibidos en un AudioBuffer de [from, to) muestras. */
function assemble(from: number, to: number) {
  const length = to - from;
  if (length <= 0 || !segments.length) return null;
  const numCh = segments.reduce((m, s) => Math.max(m, s.channels.length), 1);
  const ctx = Tone.getContext();
  const audio = ctx.createBuffer(numCh, length, ctx.sampleRate) as unknown as AudioBuffer;
  for (let c = 0; c < numCh; c++) {
    const out = audio.getChannelData(c);
    for (const seg of segments) {
      const data = seg.channels[c] ?? seg.channels[0];
      const a = Math.max(from, seg.frame);
      const b = Math.min(to, seg.frame + data.length);
      if (b <= a) continue;
      out.set(data.subarray(a - seg.frame, b - seg.frame), a - from);
    }
  }
  return audio;
}

/** Tiempos que faltan de la cuenta previa (4, 3, 2, 1) o null si no hay cuenta. */
export function countInRemaining() {
  if (useRecorder.getState().phase !== "countin") return null;
  const left = takes.startTime - Tone.getContext().currentTime;
  return Math.max(1, Math.ceil(left / beatSec - 1e-6));
}
