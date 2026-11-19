import * as Tone from "tone";
import { create } from "zustand";
import { toast } from "sonner";
import { useProject } from "@/store/project";
import * as engine from "./engine";
import { inputNode, useInput, waitForInput } from "./input";

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
export const LIVE_PEAKS_PER_SEC = 100;
export const livePeaks: number[] = [];
/** Muestra (del AudioContext) en la que empieza la toma. */
let startFrame = 0;

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
    if (frame < startFrame) continue;
    const p = Math.floor((frame - startFrame) / per);
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
let startTime = 0;
let beatSec = 0.5;

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
    if (!(await waitForInput())) {
      const { error, setPanelOpen } = useInput.getState();
      toast.error("No se puede grabar: la entrada de audio no está disponible", {
        description: error ?? undefined,
        action: { label: "Configurar", onClick: () => setPanelOpen(true) },
      });
      useRecorder.setState({ phase: "idle", trackIds: [] });
      return;
    }
    const n = await ensureNode();

    const ctx = Tone.getContext();
    const { isPlaying, countIn, bpm, setPlaying } = useProject.getState();
    segments = [];
    livePeaks.length = 0;
    engine.setRecordingMode(true);

    if (isPlaying) {
      // Ya sonando: grabar desde ya, sin cuenta previa
      startTime = ctx.currentTime;
      startFrame = Math.round(startTime * ctx.sampleRate);
      n.port.postMessage("start");
      useRecorder.setState({ phase: "recording", start: engine.positionAtTime(startTime) });
      return;
    }

    const from = engine.position();
    beatSec = 60 / bpm;
    const beats = countIn ? 4 : 0;
    const t0 = ctx.currentTime + 0.15;
    startTime = t0 + beats * beatSec;
    startFrame = Math.round(startTime * ctx.sampleRate);
    n.port.postMessage("start"); // lo anterior a startFrame se descarta al final
    if (beats) cancelCountIn = engine.countIn(t0, beats, beatSec);
    useRecorder.setState({ phase: beats ? "countin" : "recording", start: from });

    // El transporte se programa justo antes de que acabe la cuenta, para poder cancelarla
    const arm = () => {
      startTimer = null;
      engine.startAt(startTime, from);
      setPlaying(true);
      const wait = Math.max(0, (startTime - Tone.getContext().currentTime) * 1000);
      setTimeout(() => {
        if (useRecorder.getState().phase === "countin") useRecorder.setState({ phase: "recording" });
      }, wait);
    };
    const lead = (startTime - ctx.currentTime - 0.1) * 1000;
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
  if (phase === "countin" || stopTime <= startTime) {
    abort();
    return;
  }

  useRecorder.setState({ phase: "finishing" });
  cancelCountIn?.();
  cancelCountIn = null;
  await new Promise<void>((resolve) => {
    onDone = resolve;
    node!.port.postMessage("stop");
  });
  engine.setRecordingMode(false);

  const audio = assemble(startFrame, Math.round(stopTime * ctx.sampleRate));
  segments = [];
  livePeaks.length = 0;
  useRecorder.setState({ phase: "idle", trackIds: [] });
  if (!audio) return;

  const bufferId = engine.addRecordedBuffer(audio);
  const s = useProject.getState();
  const take = s.clips.filter((c) => /^Toma \d+$/.test(c.name)).length + 1;
  s.checkpoint();
  for (const trackId of trackIds) {
    if (!s.tracks.some((t) => t.id === trackId)) continue;
    s.addClip({
      id: crypto.randomUUID(),
      trackId,
      name: `Toma ${take}`,
      start,
      offset: 0,
      duration: audio.duration,
      sourceDuration: audio.duration,
      bufferId,
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
  const left = startTime - Tone.getContext().currentTime;
  return Math.max(1, Math.ceil(left / beatSec - 1e-6));
}
