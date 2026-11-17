import * as Tone from "tone";

/**
 * Motor de audio provisional basado en Web Audio (Tone.js).
 * Sirve para prototipar la UI. Más adelante el audio en tiempo real
 * (entrada de guitarra, amplis, VST3/CLAP) vivirá en el backend Rust de Tauri.
 */
let started = false;

export async function ensureAudioStarted() {
  if (!started) {
    await Tone.start();
    started = true;
  }
}

export async function play(bpm: number) {
  await ensureAudioStarted();
  Tone.getTransport().bpm.value = bpm;
  Tone.getTransport().start();
}

export function stop() {
  Tone.getTransport().stop();
}

export function setBpm(bpm: number) {
  Tone.getTransport().bpm.value = bpm;
}
