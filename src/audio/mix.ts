import * as Tone from "tone";
import type { AutoPoint, Bus, Clip, Track } from "@/store/project";

/**
 * Cuentas de la mezcla que comparten el motor en vivo y la exportación:
 * qué se oye (mute/solo con buses), valores de automatización, fundidos y ganancia de un
 * clip, y medidores de pico.
 */

export const dbOf = (gain: number) => (gain <= 0.0001 ? -Infinity : Tone.gainToDb(gain));

/**
 * Qué pistas y buses se oyen. Con algo en solo, solo suena lo que está en solo más lo que
 * lo alimenta (los buses de una pista en solo) o cuelga de ello (las pistas de un bus en solo).
 */
export function audibility(tracks: Track[], buses: Bus[]) {
  const trackAudible = new Map<string, boolean>();
  const busAudible = new Map<string, boolean>();
  const anySolo = tracks.some((t) => t.soloed) || buses.some((b) => b.soloed);
  const soloedBuses = new Set(buses.filter((b) => b.soloed).map((b) => b.id));
  const fedBySolo = new Set<string>();
  for (const t of tracks) {
    if (!t.soloed) continue;
    if (t.out) fedBySolo.add(t.out);
    for (const id of Object.keys(t.sends ?? {})) fedBySolo.add(id);
  }
  for (const t of tracks) {
    const inSoloGroup = t.soloed || (t.out !== undefined && soloedBuses.has(t.out));
    trackAudible.set(t.id, !t.muted && (!anySolo || inSoloGroup));
  }
  for (const b of buses) {
    busAudible.set(b.id, !b.muted && (!anySolo || b.soloed || fedBySolo.has(b.id)));
  }
  return { trackAudible, busAudible };
}

/** Valor de una envolvente en el instante t (interpolación lineal; fuera de los extremos se mantiene). */
export function autoValue(points: AutoPoint[] | undefined, t: number, fallback: number) {
  if (!points?.length) return fallback;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** Valores automatizados de una pista, o null si no tiene (o está desactivada). */
export function trackAutomation(track: Track) {
  if (track.autoOff) return null;
  const { volume, pan } = track.automation ?? {};
  return volume?.length || pan?.length ? { volume, pan } : null;
}

// --- Clips: ganancia y fundidos ---------------------------------------------

export const clipGain = (c: Clip) => c.gain ?? 1;
export const hasEnvelope = (c: Clip) => clipGain(c) !== 1 || (c.fadeIn ?? 0) > 0 || (c.fadeOut ?? 0) > 0;

/** Pico de la parte audible de un clip (0..1+), para normalizar. */
export function peakOf(buffer: AudioBuffer, offset: number, duration: number) {
  const from = Math.max(0, Math.floor(offset * buffer.sampleRate));
  const to = Math.min(buffer.length, Math.ceil((offset + duration) * buffer.sampleRate));
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = from; i < to; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Recorta el clip y le aplica ganancia y fundidos: devuelve un audio que suena entero, de 0 a su duración.
 * Los fundidos son de potencia constante (seno) para que un crossfade entre dos clips no baje el volumen.
 */
export function bakeClip(source: AudioBuffer, c: Clip): AudioBuffer {
  const rate = source.sampleRate;
  const from = Math.max(0, Math.round(c.offset * rate));
  const length = Math.max(1, Math.min(source.length - from, Math.round(c.duration * rate)));
  const out = new AudioBuffer({ length, numberOfChannels: source.numberOfChannels, sampleRate: rate });
  const gain = clipGain(c);
  const fin = Math.min(Math.round((c.fadeIn ?? 0) * rate), length);
  const fout = Math.min(Math.round((c.fadeOut ?? 0) * rate), length);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const src = source.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      let g = gain;
      if (i < fin) g *= Math.sin((i / fin) * (Math.PI / 2));
      const left = length - 1 - i;
      if (left < fout) g *= Math.sin((left / fout) * (Math.PI / 2));
      dst[i] = (src[from + i] ?? 0) * g;
    }
  }
  return out;
}

// --- Medidores --------------------------------------------------------------

export type PeakMeter = {
  /** Picos (0..1+) de cada canal desde la última lectura. */
  read: () => [number, number];
  dispose: () => void;
};

/** Mide el pico de izquierda y derecha de un nodo (sin alterar el sonido). */
export function peakMeter(node: Tone.ToneAudioNode): PeakMeter {
  const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext;
  const split = ctx.createChannelSplitter(2);
  const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
  for (const a of analysers) a.fftSize = 1024;
  Tone.connect(node, split);
  analysers.forEach((a, i) => split.connect(a, i));
  const data = new Float32Array(1024);
  return {
    read: () => {
      const out: [number, number] = [0, 0];
      analysers.forEach((a, i) => {
        a.getFloatTimeDomainData(data);
        let peak = 0;
        for (let k = 0; k < data.length; k++) {
          const v = Math.abs(data[k]);
          if (v > peak) peak = v;
        }
        out[i] = peak;
      });
      return out;
    },
    dispose: () => {
      try {
        Tone.disconnect(node, split);
      } catch {
        // ya estaba desconectado
      }
      split.disconnect();
      analysers.forEach((a) => a.disconnect());
    },
  };
}
