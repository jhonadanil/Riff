import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Entrada MIDI (src-tauri/src/midi.rs): controladores (la Maschine, un teclado…) que tocan
 * los instrumentos VST3. Se pueden activar varios a la vez; cada pista elige de cuál toma
 * las notas (o de cualquiera).
 */

type MidiState = {
  available: boolean;
  /** Dispositivos MIDI que se ven ahora. */
  ports: string[];
  /** Dispositivos activados (se recuerdan entre sesiones, estén o no enchufados). */
  enabled: string[];
  status: "off" | "connecting" | "on" | "error";
  /** Un mensaje por cada dispositivo que no se pudo abrir. */
  errors: string[];
  /** Ajuste (ms) para que los instrumentos suenen a tiempo con el audio de las pistas. */
  syncMs: number;
  setEnabled: (port: string, on: boolean) => void;
  setSyncMs: (ms: number) => void;
};

const KEY = "riff.midiPorts";
const OLD_KEY = "riff.midiPort";
const SYNC_KEY = "riff.midiSyncMs";

function savedPorts(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(list)) return list.filter((p): p is string => typeof p === "string");
    // Versión anterior: un solo dispositivo
    const old = localStorage.getItem(OLD_KEY);
    return old ? [old] : [];
  } catch {
    return [];
  }
}

function readSync(): number {
  try {
    const v = Number(localStorage.getItem(SYNC_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export const useMidi = create<MidiState>((set, get) => ({
  available: isTauri(),
  ports: [],
  enabled: savedPorts(),
  status: "off",
  errors: [],
  syncMs: readSync(),
  setSyncMs: (ms) => {
    const syncMs = Math.round(Math.min(300, Math.max(-150, ms)));
    try {
      localStorage.setItem(SYNC_KEY, String(syncMs));
    } catch {
      // sin almacenamiento
    }
    set({ syncMs });
  },
  setEnabled: (port, on) => {
    const enabled = on ? [...new Set([...get().enabled, port])] : get().enabled.filter((p) => p !== port);
    try {
      localStorage.setItem(KEY, JSON.stringify(enabled));
    } catch {
      // sin almacenamiento
    }
    set({ enabled });
    void connect();
  },
}));

export async function refreshMidiPorts() {
  if (!useMidi.getState().available) return;
  const ports = (await invoke<{ name: string }[]>("midi_ports").catch(() => [])).map((p) => p.name);
  useMidi.setState({ ports });
}

let token = 0;

/** Deja conectados los dispositivos activados que estén enchufados. */
async function connect() {
  const t = ++token;
  const { enabled, ports } = useMidi.getState();
  const wanted = enabled.filter((p) => ports.includes(p));
  useMidi.setState({ status: wanted.length ? "connecting" : "off", errors: [] });
  try {
    const errors = await invoke<string[]>("midi_connect", { ports: wanted });
    if (t === token) useMidi.setState({ status: errors.length ? "error" : wanted.length ? "on" : "off", errors });
  } catch (err) {
    if (t === token) useMidi.setState({ status: "error", errors: [String(err)] });
  }
}

export async function reconnectMidi() {
  await refreshMidiPorts();
  await connect();
}

/** Mensajes MIDI recibidos (para comprobar que el controlador llega). */
export async function midiEvents() {
  return invoke<{ connected: string[]; events: number }>("midi_status").then((s) => s.events);
}

// Al arrancar: reconectar los controladores de la última vez que sigan enchufados
if (useMidi.getState().available) {
  void refreshMidiPorts().then(() => {
    if (useMidi.getState().enabled.some((p) => useMidi.getState().ports.includes(p))) void connect();
  });
}
