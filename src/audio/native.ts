import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useInput, type InputChannel } from "./input";

/**
 * Puente con el motor de audio nativo (src-tauri/src/audio.rs).
 *
 * Primer hito: monitorizar la entrada en tiempo real por ASIO/WASAPI.
 * Cuando el motor nativo está encendido, el botón de auriculares de las
 * pistas usa este camino (latencia de pocos ms) en vez del de Web Audio.
 */

export type NativeHost = { id: string; name: string };
export type NativeDevice = {
  id: string;
  name: string;
  inputs: number;
  outputs: number;
  sampleRate: number | null;
  bufferRange: [number, number] | null;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
};
export type NativeInfo = {
  host: string;
  inputName: string;
  outputName: string;
  sampleRate: number;
  bufferSize: number | null;
  inputChannels: number;
  outputChannels: number;
};
export type NativeMeter = { peaks: [number, number]; xruns: number; inputLatencyMs: number; outputLatencyMs: number };

type NativeState = {
  /** Estamos dentro de la app de escritorio (no en un navegador). */
  available: boolean;
  enabled: boolean;
  hosts: NativeHost[];
  host: string | null;
  devices: NativeDevice[];
  inputId: string | null;
  outputId: string | null;
  /** null = el que diga el driver. */
  bufferSize: number | null;
  status: "off" | "starting" | "on" | "error";
  error: string | null;
  info: NativeInfo | null;

  setEnabled: (on: boolean) => void;
  setHost: (host: string) => void;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  setBufferSize: (frames: number | null) => void;
};

const PREFS_KEY = "riff.nativeAudio";
type Prefs = Pick<NativeState, "enabled" | "host" | "inputId" | "outputId" | "bufferSize">;

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      enabled: v.enabled === true,
      host: typeof v.host === "string" ? v.host : null,
      inputId: typeof v.inputId === "string" ? v.inputId : null,
      outputId: typeof v.outputId === "string" ? v.outputId : null,
      bufferSize: typeof v.bufferSize === "number" ? v.bufferSize : null,
    };
  } catch {
    return { enabled: false, host: null, inputId: null, outputId: null, bufferSize: null };
  }
}

export const useNative = create<NativeState>((set) => ({
  ...readPrefs(),
  available: isTauri(),
  hosts: [],
  devices: [],
  status: "off",
  error: null,
  info: null,

  setEnabled: (enabled) => set({ enabled }),
  // Al cambiar de sistema de audio los dispositivos son otros
  setHost: (host) => set({ host, inputId: null, outputId: null, devices: [] }),
  setInput: (inputId) => set({ inputId }),
  setOutput: (outputId) => set({ outputId }),
  setBufferSize: (bufferSize) => set({ bufferSize }),
}));

const channelIndex = (c: InputChannel) => (c === "1" ? 0 : c === "2" ? 1 : 2);

// --- Dispositivos -----------------------------------------------------------------

export async function refreshNativeDevices() {
  if (!useNative.getState().available) return;
  try {
    const hosts = await invoke<NativeHost[]>("audio_hosts");
    const s = useNative.getState();
    // Preferir ASIO si existe: es el que da la latencia baja
    const host = s.host && hosts.some((h) => h.id === s.host) ? s.host : (hosts.find((h) => h.id === "ASIO") ?? hosts[0])?.id ?? null;
    useNative.setState({ hosts, host });
    if (!host) return;
    const devices = await invoke<NativeDevice[]>("audio_devices", { host });
    const cur = useNative.getState();
    const pick = (id: string | null, ok: (d: NativeDevice) => boolean, isDefault: (d: NativeDevice) => boolean) =>
      id && devices.some((d) => d.id === id && ok(d)) ? id : (devices.find((d) => ok(d) && isDefault(d)) ?? devices.find(ok))?.id ?? null;
    const inputId = pick(cur.inputId, (d) => d.inputs > 0, (d) => d.isDefaultInput);
    // Con ASIO entrada y salida son el mismo driver
    const outputId =
      host === "ASIO" && inputId
        ? inputId
        : pick(cur.outputId, (d) => d.outputs > 0, (d) => d.isDefaultOutput);
    useNative.setState({ devices, inputId, outputId });
  } catch (err) {
    useNative.setState({ status: "error", error: String(err) });
  }
}

// --- Arrancar / parar ------------------------------------------------------------------

let startToken = 0;

async function start() {
  const token = ++startToken;
  const s = useNative.getState();
  if (!s.host || !s.inputId || !s.outputId) {
    useNative.setState({ status: "error", error: "Elige un dispositivo de entrada y otro de salida." });
    return;
  }
  useNative.setState({ status: "starting", error: null });
  try {
    const info = await invoke<NativeInfo>("audio_start", {
      config: {
        host: s.host,
        inputDevice: s.inputId,
        outputDevice: s.outputId,
        bufferSize: s.bufferSize,
        inputChannel: channelIndex(useInput.getState().channel),
      },
    });
    if (token !== startToken) return;
    useNative.setState({ status: "on", info });
    syncMonitor();
  } catch (err) {
    if (token !== startToken) return;
    useNative.setState({ status: "error", error: String(err), info: null });
    syncMonitor();
  }
}

async function stop() {
  startToken++;
  useNative.setState({ status: "off", info: null, error: null });
  syncMonitor();
  await invoke("audio_stop").catch(console.error);
}

/** Con el motor nativo encendido, monitorizar = escuchar por él (y no por Web Audio). */
function syncMonitor() {
  const on = useNative.getState().status === "on";
  const monitoring = useInput.getState().monitored.length > 0;
  if (useInput.getState().nativeMonitor !== on) useInput.setState({ nativeMonitor: on });
  if (useNative.getState().available) void invoke("audio_set_monitor", { on: on && monitoring }).catch(console.error);
}

export async function nativeMeter() {
  return invoke<NativeMeter>("audio_meter");
}

export function restartNative() {
  if (useNative.getState().enabled) void start();
}

// --- Ciclo de vida ---------------------------------------------------------------------

useNative.subscribe((s, prev) => {
  if (s.enabled !== prev.enabled || s.host !== prev.host || s.inputId !== prev.inputId || s.outputId !== prev.outputId || s.bufferSize !== prev.bufferSize) {
    try {
      const prefs: Prefs = { enabled: s.enabled, host: s.host, inputId: s.inputId, outputId: s.outputId, bufferSize: s.bufferSize };
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // sin almacenamiento
    }
  }
  if (s.host !== prev.host && s.host) void refreshNativeDevices();

  const config = s.inputId !== prev.inputId || s.outputId !== prev.outputId || s.bufferSize !== prev.bufferSize || s.host !== prev.host;
  if (!s.enabled && prev.enabled) void stop();
  else if (s.enabled && (!prev.enabled || config) && s.inputId && s.outputId) void start();
});

useInput.subscribe((s, prev) => {
  if (s.channel !== prev.channel && useNative.getState().status === "on") {
    void invoke("audio_set_input_channel", { channel: channelIndex(s.channel) }).catch(console.error);
  }
  if (s.monitored !== prev.monitored) syncMonitor();
});

if (useNative.getState().available) {
  void refreshNativeDevices().then(() => {
    const s = useNative.getState();
    if (s.enabled && s.inputId && s.outputId && s.status === "off") void start();
  });
}
