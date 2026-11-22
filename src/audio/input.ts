import * as Tone from "tone";
import { create } from "zustand";
import { useProject, type Track } from "@/store/project";
import * as engine from "./engine";

/**
 * Entrada de audio (interfaz o micro) vía getUserMedia.
 *
 * Grafo:  micro → [selección de canal] → out ─┬→ analizador (medidor)
 *                                             └→ canal de cada pista monitorizada
 *
 * La entrada solo está abierta mientras alguien la necesita (el diálogo de
 * entrada visible o alguna pista monitorizando), para no tener el micro
 * ocupado sin motivo.
 */

/** Qué canales de la interfaz se usan: entrada 1, entrada 2 o las dos en estéreo. */
export type InputChannel = "1" | "2" | "stereo";

/** Cómo se lo cuenta al motor nativo: 0 = entrada 1, 1 = entrada 2, 2 = las dos. */
export const channelIndex = (c: InputChannel) => (c === "1" ? 0 : c === "2" ? 1 : 2);
export type InputDevice = { id: string; label: string };

type InputState = {
  devices: InputDevice[];
  /** null = el dispositivo predeterminado del sistema. */
  deviceId: string | null;
  channel: InputChannel;
  status: "closed" | "opening" | "open" | "error";
  error: string | null;
  /** Canales que entrega realmente el dispositivo abierto (1 = mono). */
  streamChannels: number;
  /** Latencia estimada en ms; la de entrada no siempre la informa el sistema. */
  latency: { input: number | null; output: number } | null;
  /** Pistas en las que te oyes al tocar (botón de auriculares). Con el monitor silenciado no suena ninguna. */
  monitored: string[];
  /** Monitor silenciado (p. ej. cantando con micro y parlantes, para que no se acople). */
  monitorMuted: boolean;
  /** El diálogo de entrada está visible (necesita el medidor). */
  panelOpen: boolean;
  /** Hay alguna pista armada: la entrada se deja abierta para grabar al instante. */
  armed: boolean;
  /** Ajuste manual (ms) que se suma a la compensación automática al grabar. */
  latencyOffsetMs: number;
  /** El motor nativo se encarga de monitorizar (src/audio/native.ts): Web Audio no lo hace. */
  nativeMonitor: boolean;

  setDevice: (deviceId: string | null) => void;
  setChannel: (channel: InputChannel) => void;
  toggleMonitor: (trackId: string) => void;
  setMonitorMuted: (muted: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  setLatencyOffset: (ms: number) => void;
};

// --- Preferencias guardadas -------------------------------------------------

const PREFS_KEY = "riff.audioInput";

type Prefs = { deviceId: string | null; channel: InputChannel; latencyOffsetMs: number };

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      deviceId: typeof v.deviceId === "string" ? v.deviceId : null,
      channel: v.channel === "2" || v.channel === "stereo" ? v.channel : "1",
      latencyOffsetMs: typeof v.latencyOffsetMs === "number" ? v.latencyOffsetMs : 0,
    };
  } catch {
    return { deviceId: null, channel: "1", latencyOffsetMs: 0 };
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // sin almacenamiento: se usará el predeterminado la próxima vez
  }
}

export const useInput = create<InputState>((set) => ({
  ...readPrefs(),
  devices: [],
  status: "closed",
  error: null,
  streamChannels: 2,
  latency: null,
  monitored: [],
  monitorMuted: false,
  panelOpen: false,
  armed: useProject.getState().tracks.some((t) => t.armed),
  nativeMonitor: false,

  setDevice: (deviceId) => set({ deviceId }),
  setChannel: (channel) => set({ channel }),
  toggleMonitor: (trackId) =>
    set((s) => ({
      monitored: s.monitored.includes(trackId) ? s.monitored.filter((id) => id !== trackId) : [...s.monitored, trackId],
    })),
  setMonitorMuted: (monitorMuted) => set({ monitorMuted }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setLatencyOffset: (ms) => set({ latencyOffsetMs: Math.round(Math.min(200, Math.max(-100, ms))) }),
}));

// --- Dispositivos -----------------------------------------------------------

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const all = await navigator.mediaDevices.enumerateDevices();
  const devices = all
    // En Windows "communications" es un alias del dispositivo de llamadas: sobra
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "communications")
    .map((d, i) => ({
      id: d.deviceId,
      label:
        d.deviceId === "default"
          ? `Predeterminado del sistema${d.label ? ` (${d.label.replace(/^(Default|Predeterminado) - /, "")})` : ""}`
          : d.label || `Entrada ${i + 1}`,
    }))
    .filter((d) => d.id !== "default"); // el predeterminado se representa con deviceId = null
  useInput.setState({ devices });

  // Si el dispositivo elegido ha desaparecido (se desenchufó), volver al predeterminado
  const { deviceId } = useInput.getState();
  if (deviceId && devices.length && !devices.some((d) => d.id === deviceId)) {
    useInput.setState({ deviceId: null });
  }
}

navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices());

// --- Grafo de audio ---------------------------------------------------------

let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
/** Nodos de selección de canal; se rehacen al cambiar de canal. */
let route: Tone.ToneAudioNode[] = [];
/** Salida de la entrada: mono (entrada 1 o 2) o estéreo. */
const out = new Tone.Gain();
/** Una salida por cada elección de entrada: cada pista monitorizada toma la suya (guitarra en la 2, voz en la 1…). */
const monitorOut: Record<InputChannel, Tone.Gain> = { "1": new Tone.Gain(), "2": new Tone.Gain(), stereo: new Tone.Gain() };
monitorOut["1"].channelCount = 1;
monitorOut["2"].channelCount = 1;
monitorOut.stereo.channelCount = 2;
for (const g of Object.values(monitorOut)) g.channelCountMode = "explicit";
/** Las dos entradas de la interfaz tal cual (para grabar cada pista con la suya). */
const rawOut = new Tone.Gain();
rawOut.channelCount = 2;
rawOut.channelCountMode = "explicit";
const analyser = new Tone.Analyser({ type: "waveform", size: 1024, channels: 2 });
out.connect(analyser);
/** Señal tal cual llega del dispositivo, canal por canal (para ver dónde entra cada instrumento). */
const rawAnalyser = new Tone.Analyser({ type: "waveform", size: 1024, channels: 2 });

/** Intentos de apertura en curso: si llega uno nuevo, el anterior se descarta. */
let openToken = 0;

function errorMessage(err: unknown) {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError")
    return "Permiso de micrófono denegado. Actívalo en Configuración de Windows › Privacidad y seguridad › Micrófono.";
  if (name === "NotFoundError") return "No se ha encontrado ninguna entrada de audio.";
  if (name === "NotReadableError") return "La entrada está ocupada por otra aplicación o no responde.";
  return err instanceof Error ? err.message : String(err);
}

function buildRoute() {
  for (const n of route) n.dispose();
  route = [];
  for (const n of monitorRoute) n.dispose();
  monitorRoute = [];
  if (!source) return;
  source.disconnect();
  Tone.connect(source, rawAnalyser);
  Tone.connect(source, rawOut);
  buildMonitorRoute();

  const { channel } = useInput.getState();
  if (channel === "stereo") {
    out.channelCount = 2;
    out.channelCountMode = "explicit";
    Tone.connect(source, out);
    return;
  }
  // Un solo canal de la interfaz (p. ej. la guitarra en la entrada 1) como señal mono
  const split = new Tone.Split(2);
  const mono = new Tone.Gain();
  mono.channelCount = 1;
  mono.channelCountMode = "explicit";
  Tone.connect(source, split);
  split.connect(mono, channel === "2" ? 1 : 0, 0);
  out.channelCount = 1;
  out.channelCountMode = "explicit";
  mono.connect(out);
  route = [split, mono];
}

/** Reparte la señal en las tres salidas de monitor (entrada 1, entrada 2, estéreo). */
let monitorRoute: Tone.ToneAudioNode[] = [];

function buildMonitorRoute() {
  if (!source) return;
  const split = new Tone.Split(2);
  Tone.connect(source, split);
  split.connect(monitorOut["1"], 0, 0);
  split.connect(monitorOut["2"], 1, 0);
  Tone.connect(source, monitorOut.stereo);
  monitorRoute.push(split);
}

function measureLatency() {
  const raw = Tone.getContext().rawContext as unknown as { baseLatency?: number; outputLatency?: number };
  const output = ((raw.baseLatency ?? 0) + (raw.outputLatency ?? 0)) * 1000;
  const settings = stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
  const input = typeof settings?.latency === "number" ? settings.latency * 1000 : null;
  useInput.setState({ latency: { input, output } });
}

async function openInput() {
  const token = ++openToken;
  closeInput(false);
  useInput.setState({ status: "opening", error: null });
  try {
    await engine.ensureAudioStarted();
    const { deviceId } = useInput.getState();
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // Nada de procesado de "videollamada": queremos la señal tal cual
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        sampleRate: { ideal: Tone.getContext().sampleRate },
        latency: { ideal: 0 },
      } as MediaTrackConstraints,
    });
    if (token !== openToken) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    source = Tone.getContext().createMediaStreamSource(s) as unknown as MediaStreamAudioSourceNode;
    const track = s.getAudioTracks()[0];
    console.info("[entrada] abierta:", track?.label, track?.getSettings());
    useInput.setState({ status: "open", streamChannels: track?.getSettings().channelCount ?? 2 });
    track?.addEventListener("ended", () => {
      if (stream === s) useInput.setState({ status: "error", error: "Se ha perdido la entrada de audio." });
    });
    buildRoute();
    syncMonitoring();
    measureLatency();
    // Con permiso concedido ya hay nombres de dispositivo
    await refreshDevices();
  } catch (err) {
    if (token !== openToken) return;
    console.error(err);
    // Si el dispositivo guardado ya no existe, probar con el predeterminado
    if (err instanceof DOMException && err.name === "OverconstrainedError" && useInput.getState().deviceId) {
      useInput.setState({ deviceId: null });
      return;
    }
    useInput.setState({ status: "error", error: errorMessage(err) });
  }
}

function closeInput(updateStatus = true) {
  for (const c of connected.values()) safeDisconnect(c);
  connected.clear();
  for (const n of route) n.dispose();
  route = [];
  for (const n of monitorRoute) n.dispose();
  monitorRoute = [];
  source?.disconnect();
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (updateStatus) {
    openToken++;
    useInput.setState({ status: "closed", error: null, latency: null });
  }
}

// --- Monitorización ---------------------------------------------------------

/** Pistas a cuyo canal está conectada ahora la entrada. */
const connected = new Map<string, { ch: Tone.Channel; src: Tone.Gain }>();

function safeDisconnect({ ch, src }: { ch: Tone.Channel; src: Tone.Gain }) {
  try {
    src.disconnect(ch);
  } catch {
    // el canal ya se había desconectado o eliminado
  }
}

/** Pistas que se oyen ahora: las elegidas, salvo que el monitor esté silenciado. */
export const audibleMonitored = (s: Pick<InputState, "monitored" | "monitorMuted">) => (s.monitorMuted ? [] : s.monitored);

function syncMonitoring() {
  const { status, nativeMonitor } = useInput.getState();
  const monitored = audibleMonitored(useInput.getState());
  const want = new Map<string, { ch: Tone.Channel; src: Tone.Gain }>();
  if (status === "open" && !nativeMonitor) {
    const { tracks } = useProject.getState();
    for (const id of monitored) {
      const ch = engine.trackChannel(id);
      const track = tracks.find((t) => t.id === id);
      if (ch && track) want.set(id, { ch, src: monitorOut[trackInput(track)] });
    }
  }
  for (const [id, c] of connected) {
    const w = want.get(id);
    if (!w || w.ch !== c.ch || w.src !== c.src) {
      safeDisconnect(c);
      connected.delete(id);
    }
  }
  for (const [id, w] of want) {
    if (!connected.has(id)) {
      w.src.connect(w.ch);
      connected.set(id, w);
    }
  }
}

// --- Ciclo de vida ----------------------------------------------------------

// Con el motor nativo encendido la interfaz la tiene abierta él: el navegador no la abre (ni hace falta)
const needsInput = (s: InputState) => !s.nativeMonitor && (s.panelOpen || s.armed || s.monitored.length > 0);

useInput.subscribe((s, prev) => {
  if (s.deviceId !== prev.deviceId || s.channel !== prev.channel || s.latencyOffsetMs !== prev.latencyOffsetMs) {
    writePrefs({ deviceId: s.deviceId, channel: s.channel, latencyOffsetMs: s.latencyOffsetMs });
  }

  const wanted = needsInput(s);
  if (wanted && (s.status === "closed" || s.deviceId !== prev.deviceId)) {
    void openInput();
  } else if (wanted && s.status === "error" && !needsInput(prev)) {
    void openInput(); // reintentar al volver a pedirla
  } else if (!wanted && s.status !== "closed") {
    closeInput();
  }

  if (s.channel !== prev.channel) {
    buildRoute();
    syncMonitoring();
  }
  if (
    s.monitored !== prev.monitored ||
    s.monitorMuted !== prev.monitorMuted ||
    s.status !== prev.status ||
    s.nativeMonitor !== prev.nativeMonitor
  ) {
    syncMonitoring();
  }
});

// Al borrar pistas (o abrir otro proyecto) dejar de monitorizar las que ya no existen
useProject.subscribe((state, prev) => {
  if (state.tracks === prev.tracks) return;
  const armed = state.tracks.some((t) => t.armed);
  if (armed !== useInput.getState().armed) useInput.setState({ armed });
  const ids = new Set(state.tracks.map((t) => t.id));
  const { monitored } = useInput.getState();
  const kept = monitored.filter((id) => ids.has(id));
  if (kept.length !== monitored.length) useInput.setState({ monitored: kept });
  else syncMonitoring(); // por si el motor ha recreado algún canal
});

/** Espera a que la entrada esté abierta (true) o falle (false). */
export function waitForInput(timeoutMs = 8000): Promise<boolean> {
  const done = (s: InputState) => s.status === "open" || s.status === "error";
  const now = useInput.getState();
  if (done(now)) return Promise.resolve(now.status === "open");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = useInput.subscribe((s) => {
      if (!done(s)) return;
      clearTimeout(timer);
      unsub();
      resolve(s.status === "open");
    });
  });
}

/**
 * Cuánto llega tarde lo grabado respecto a la línea de tiempo (ms):
 * oyes el metrónomo con la latencia de salida y tu nota entra con la de entrada.
 * Si el sistema no informa de la de entrada, se supone igual a la de salida
 * (los búferes de Windows suelen ser simétricos). Más el ajuste manual.
 */
export function recordingLatencyMs() {
  const { latency, latencyOffsetMs } = useInput.getState();
  const auto = latency ? (latency.input ?? latency.output) + latency.output : 0;
  return { auto, offset: latencyOffsetMs, total: auto + latencyOffsetMs };
}

/** Últimos picos de las dos entradas según el motor nativo (los escribe src/audio/levels.ts). */
export const nativePeaks: [number, number] = [0, 0];

/** Nodo con las dos entradas de la interfaz tal cual, para grabarlas (cada pista toma la suya). */
export function inputNode() {
  return rawOut;
}

/** Entrada que usa una pista: la suya o, si no tiene, la predeterminada de los ajustes. */
export function trackInput(t: Track): InputChannel {
  return t.input ?? useInput.getState().channel;
}

/** Vuelve a intentar abrir la entrada (tras un error). */
export function retryInput() {
  if (needsInput(useInput.getState())) void openInput();
}

/**
 * Nivel actual (lineal, 0..1+): pico y RMS del último bloque.
 * Sin argumento, la señal que se usa (tras elegir canal); con 0 o 1, esa entrada del dispositivo en bruto.
 */
export function inputLevel(rawChannel?: 0 | 1) {
  const st = useInput.getState();
  // Con el motor nativo los niveles vienen de él (los lee src/audio/levels.ts)
  if (st.nativeMonitor) {
    const [a, b] = nativePeaks;
    const peak = rawChannel !== undefined ? nativePeaks[rawChannel] : st.channel === "1" ? a : st.channel === "2" ? b : Math.max(a, b);
    return { peak, rms: peak * 0.7 };
  }
  if (st.status !== "open") return { peak: 0, rms: 0 };
  const value = (rawChannel === undefined ? analyser : rawAnalyser).getValue();
  const all = Array.isArray(value) ? value : [value];
  const chans = rawChannel === undefined ? all : all.slice(rawChannel, rawChannel + 1);
  let peak = 0;
  let rms = 0;
  for (const data of chans) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    rms = Math.max(rms, Math.sqrt(sum / data.length));
  }
  return { peak, rms };
}

void refreshDevices();
