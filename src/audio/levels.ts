import { inputLevel, nativePeaks, useInput } from "./input";
import { nativeMeter, useNative, type NativeMeter } from "./native";

/**
 * Niveles de las dos entradas de la interfaz (picos desde la última lectura).
 *
 * El motor nativo entrega los picos y los pone a cero al leerlos, así que solo puede
 * leerlos uno: este módulo es ese único lector y se los reparte a quien los pida
 * (los medidores de las pistas, el estado del motor…).
 */

export type Levels = {
  peaks: [number, number];
  /** Medidas completas del motor nativo (latencia, cortes); null si no está en marcha. */
  meter: NativeMeter | null;
};

const subs = new Set<(l: Levels) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    let levels: Levels = { peaks: [0, 0], meter: null };
    if (useNative.getState().status === "on") {
      const m = await nativeMeter().catch(() => null);
      if (m) {
        levels = { peaks: m.peaks, meter: m };
        nativePeaks[0] = m.peaks[0];
        nativePeaks[1] = m.peaks[1];
      }
    } else if (useInput.getState().status === "open") {
      levels = { peaks: [inputLevel(0).peak, inputLevel(1).peak], meter: null };
    }
    subs.forEach((fn) => fn(levels));
  } finally {
    busy = false;
  }
}

/** Recibe los niveles unas 20 veces por segundo. Devuelve la función para dejar de recibirlos. */
export function subscribeLevels(fn: (l: Levels) => void) {
  subs.add(fn);
  timer ??= setInterval(tick, 50);
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
