import * as Tone from "tone";
import { create } from "zustand";
import { useProject } from "@/store/project";
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
  /** Pistas que están monitorizando la entrada. */
  monitored: string[];
  /** El diálogo de entrada está visible (necesita el medidor). */
  panelOpen: boolean;

  setDevice: (deviceId: string | null) => void;
  setChannel: (channel: InputChannel) => void;
  toggleMonitor: (trackId: string) => void;
  setPanelOpen: (open: boolean) => void;
};

// --- Preferencias guardadas -------------------------------------------------

const PREFS_KEY = "riff.audioInput";

function readPrefs(): { deviceId: string | null; channel: InputChannel } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      deviceId: typeof v.deviceId === "string" ? v.deviceId : null,
      channel: v.channel === "2" || v.channel === "stereo" ? v.channel : "1",
    };
  } catch {
    return { deviceId: null, channel: "1" };
  }
}

function writePrefs(deviceId: string | null, channel: InputChannel) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ deviceId, channel }));
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
  panelOpen: false,

  setDevice: (deviceId) => set({ deviceId }),
  setChannel: (channel) => set({ channel }),
  toggleMonitor: (trackId) =>
    set((s) => ({
      monitored: s.monitored.includes(trackId) ? s.monitored.filter((id) => id !== trackId) : [...s.monitored, trackId],
    })),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
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
  if (!source) return;
  source.disconnect();
  Tone.connect(source, rawAnalyser);

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
  for (const ch of connected.values()) safeDisconnect(ch);
  connected.clear();
  for (const n of route) n.dispose();
  route = [];
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
const connected = new Map<string, Tone.Channel>();

function safeDisconnect(ch: Tone.Channel) {
  try {
    out.disconnect(ch);
  } catch {
    // el canal ya se había desconectado o eliminado
  }
}

function syncMonitoring() {
  const { monitored, status } = useInput.getState();
  const want = new Map<string, Tone.Channel>();
  if (status === "open") {
    for (const id of monitored) {
      const ch = engine.trackChannel(id);
      if (ch) want.set(id, ch);
    }
  }
  for (const [id, ch] of connected) {
    if (want.get(id) !== ch) {
      safeDisconnect(ch);
      connected.delete(id);
    }
  }
  for (const [id, ch] of want) {
    if (!connected.has(id)) {
      out.connect(ch);
      connected.set(id, ch);
    }
  }
}

// --- Ciclo de vida ----------------------------------------------------------

const needsInput = (s: InputState) => s.panelOpen || s.monitored.length > 0;

useInput.subscribe((s, prev) => {
  if (s.deviceId !== prev.deviceId || s.channel !== prev.channel) writePrefs(s.deviceId, s.channel);

  const wanted = needsInput(s);
  if (wanted && (s.status === "closed" || s.deviceId !== prev.deviceId)) {
    void openInput();
  } else if (wanted && s.status === "error" && !needsInput(prev)) {
    void openInput(); // reintentar al volver a pedirla
  } else if (!wanted && s.status !== "closed") {
    closeInput();
  }

  if (s.channel !== prev.channel) buildRoute();
  if (s.monitored !== prev.monitored || s.status !== prev.status) syncMonitoring();
});

// Al borrar pistas (o abrir otro proyecto) dejar de monitorizar las que ya no existen
useProject.subscribe((state, prev) => {
  if (state.tracks === prev.tracks) return;
  const ids = new Set(state.tracks.map((t) => t.id));
  const { monitored } = useInput.getState();
  const kept = monitored.filter((id) => ids.has(id));
  if (kept.length !== monitored.length) useInput.setState({ monitored: kept });
  else syncMonitoring(); // por si el motor ha recreado algún canal
});

/** Vuelve a intentar abrir la entrada (tras un error). */
export function retryInput() {
  if (needsInput(useInput.getState())) void openInput();
}

/**
 * Nivel actual (lineal, 0..1+): pico y RMS del último bloque.
 * Sin argumento, la señal que se usa (tras elegir canal); con 0 o 1, esa entrada del dispositivo en bruto.
 */
export function inputLevel(rawChannel?: 0 | 1) {
  if (useInput.getState().status !== "open") return { peak: 0, rms: 0 };
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
