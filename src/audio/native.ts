import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { audibleMonitored, channelIndex, useInput } from "./input";

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
  outputHost: string;
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
  /** Sistema de audio de la salida; null = el mismo que la entrada. */
  outputHost: string | null;
  devices: NativeDevice[];
  /** Dispositivos del sistema de la salida (los mismos que `devices` si es el mismo sistema). */
  outputDevices: NativeDevice[];
  inputId: string | null;
  outputId: string | null;
  /** null = el que diga el driver. */
  bufferSize: number | null;
  status: "off" | "starting" | "on" | "error";
  error: string | null;
  info: NativeInfo | null;

  setEnabled: (on: boolean) => void;
  setHost: (host: string) => void;
  setOutputHost: (host: string) => void;
  setInput: (id: string) => void;
  setOutput: (id: string) => void;
  setBufferSize: (frames: number | null) => void;
};

const PREFS_KEY = "riff.nativeAudio";
type Prefs = Pick<NativeState, "enabled" | "host" | "outputHost" | "inputId" | "outputId" | "bufferSize">;

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      enabled: v.enabled === true,
      host: typeof v.host === "string" ? v.host : null,
      outputHost: typeof v.outputHost === "string" ? v.outputHost : null,
      inputId: typeof v.inputId === "string" ? v.inputId : null,
      outputId: typeof v.outputId === "string" ? v.outputId : null,
      bufferSize: typeof v.bufferSize === "number" ? v.bufferSize : null,
    };
  } catch {
    return { enabled: false, host: null, outputHost: null, inputId: null, outputId: null, bufferSize: null };
  }
}

export const useNative = create<NativeState>((set) => ({
  ...readPrefs(),
  available: isTauri(),
  hosts: [],
  devices: [],
  outputDevices: [],
  status: "off",
  error: null,
  info: null,

  setEnabled: (enabled) => set({ enabled }),
  // Al cambiar de sistema de audio los dispositivos son otros
  setHost: (host) => set({ host, inputId: null, outputId: null, devices: [], outputDevices: [] }),
  setOutputHost: (outputHost) => set({ outputHost, outputId: null, outputDevices: [] }),
  setInput: (inputId) => set({ inputId }),
  setOutput: (outputId) => set({ outputId }),
  setBufferSize: (bufferSize) => set({ bufferSize }),
}));

// --- Dispositivos -----------------------------------------------------------------

/**
 * Lee los sistemas de audio y sus dispositivos. Con `auto` (arranque, reintentos), si el sistema
 * elegido no tiene dispositivos (p. ej. ASIO sin ningún driver instalado) salta al primero que sí los tenga;
 * si lo acaba de elegir el usuario (`auto = false`) se respeta y se le explica qué falta.
 */
export async function refreshNativeDevices(auto = true) {
  if (!useNative.getState().available) return;
  try {
    const hosts = await invoke<NativeHost[]>("audio_hosts");
    const s = useNative.getState();
    // Preferir ASIO si existe: es el que da la latencia baja
    let host = s.host && hosts.some((h) => h.id === s.host) ? s.host : (hosts.find((h) => h.id === "ASIO") ?? hosts[0])?.id ?? null;
    useNative.setState({ hosts, host });
    if (!host) return;
    // Si la consulta falla (p. ej. el motor está arrancando el driver) no es "sin dispositivos": se deja el error y no se cambia de sistema
    let devices = await invoke<NativeDevice[]>("audio_devices", { host });
    // Un driver ASIO abierto por el motor puede no dejar listarse otra vez: se conserva la lista que ya teníamos
    if (devices.length === 0 && s.devices.length > 0 && s.host === host) devices = s.devices;
    if (devices.length === 0 && auto) {
      // ASIO existe siempre en Windows, aunque no haya ningún driver: probar con los demás
      for (const h of [...hosts].sort((a, b) => Number(b.id === "WASAPI") - Number(a.id === "WASAPI"))) {
        if (h.id === host) continue;
        const list = await invoke<NativeDevice[]>("audio_devices", { host: h.id }).catch(() => [] as NativeDevice[]);
        if (list.length) {
          host = h.id;
          devices = list;
          useNative.setState({ host, outputHost: null, inputId: null, outputId: null });
          break;
        }
      }
    }
    const cur = useNative.getState();
    const outHost = cur.outputHost && hosts.some((h) => h.id === cur.outputHost) ? cur.outputHost : host;
    const outputDevices = outHost === host ? devices : await invoke<NativeDevice[]>("audio_devices", { host: outHost });
    const pick = (list: NativeDevice[], id: string | null, ok: (d: NativeDevice) => boolean, isDefault: (d: NativeDevice) => boolean) =>
      id && list.some((d) => d.id === id && ok(d)) ? id : (list.find((d) => ok(d) && isDefault(d)) ?? list.find(ok))?.id ?? null;
    const inputId = pick(devices, cur.inputId, (d) => host === "ASIO" || d.inputs > 0, (d) => d.isDefaultInput);
    // Con ASIO en los dos lados, entrada y salida son el mismo driver (solo se puede abrir uno)
    const outputId =
      host === "ASIO" && outHost === "ASIO" && inputId
        ? inputId
        : pick(outputDevices, cur.outputId, (d) => outHost === "ASIO" || d.outputs > 0, (d) => d.isDefaultOutput);
    useNative.setState({ devices, outputDevices, outputHost: outHost === host ? null : outHost, inputId, outputId });
    if (devices.length > 0 && useNative.getState().status === "error" && !useNative.getState().enabled) {
      useNative.setState({ status: "off", error: null });
    }
    if (devices.length === 0) {
      useNative.setState({
        status: "error",
        error: `El sistema ${host} no ha devuelto ningún dispositivo. Si es ASIO: ¿está instalado el driver (ASIO4ALL o el de tu interfaz) y la interfaz conectada?`,
      });
    }
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
        outputHost: s.outputHost,
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
  const monitoring = audibleMonitored(useInput.getState()).length > 0;
  if (useInput.getState().nativeMonitor !== on) useInput.setState({ nativeMonitor: on });
  if (useNative.getState().available) void invoke("audio_set_monitor", { on: on && monitoring }).catch(console.error);
}

export async function nativeMeter() {
  return invoke<NativeMeter>("audio_meter");
}

export async function restartNative() {
  if (!useNative.getState().enabled) return;
  await refreshNativeDevices();
  void start();
}

// --- Ciclo de vida ---------------------------------------------------------------------

useNative.subscribe((s, prev) => {
  if (s.enabled !== prev.enabled || s.host !== prev.host || s.outputHost !== prev.outputHost || s.inputId !== prev.inputId || s.outputId !== prev.outputId || s.bufferSize !== prev.bufferSize) {
    try {
      const prefs: Prefs = { enabled: s.enabled, host: s.host, outputHost: s.outputHost, inputId: s.inputId, outputId: s.outputId, bufferSize: s.bufferSize };
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // sin almacenamiento
    }
  }
  if ((s.host !== prev.host && s.host) || s.outputHost !== prev.outputHost) void refreshNativeDevices(s.host === prev.host); // cambiar solo la salida no debe dejar una entrada sin drivers atascada

  const config = s.outputHost !== prev.outputHost || s.inputId !== prev.inputId || s.outputId !== prev.outputId || s.bufferSize !== prev.bufferSize || s.host !== prev.host;
  if (!s.enabled && prev.enabled) void stop();
  else if (s.enabled && (!prev.enabled || config) && s.inputId && s.outputId) void start();
});

useInput.subscribe((s, prev) => {
  if (s.channel !== prev.channel && useNative.getState().status === "on") {
    void invoke("audio_set_input_channel", { channel: channelIndex(s.channel) }).catch(console.error);
  }
  if (s.monitored !== prev.monitored || s.monitorMuted !== prev.monitorMuted) syncMonitor();
});

if (useNative.getState().available) {
  void refreshNativeDevices().then(() => {
    const s = useNative.getState();
    if (s.enabled && s.inputId && s.outputId && s.status === "off") void start();
  });
}
