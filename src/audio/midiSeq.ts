import { invoke, isTauri } from "@tauri-apps/api/core";
import { useProject } from "@/store/project";
import * as engine from "./engine";
import { midiNotesByTrack } from "./midiNotes";
import { audibility, autoValue, trackAutomation } from "./mix";
import { useMidi } from "./midi";

/**
 * Reproduce los clips MIDI por el motor nativo (src-tauri/src/plugins.rs).
 *
 * El audio de las pistas suena por Web Audio y los instrumentos por el motor
 * nativo: son dos caminos distintos. Aquí se les dice qué notas hay y dónde
 * está la canción cada vez que arranca, salta o se repite; el motor nativo
 * toca las notas con su propio reloj, a partir de ahí.
 */

if (isTauri()) {
  const call = (cmd: string, args?: Record<string, unknown>) => void invoke(cmd, args).catch(() => {});

  /** Notas de todos los clips MIDI, con tiempos absolutos en la línea de tiempo. */
  const syncClips = () => {
    call("midi_set_clips", { clips: midiNotesByTrack(useProject.getState().clips) });
  };

  /**
   * Volumen, si se oye (mute/solo) y panorama de cada pista. Lo que suena por el motor nativo
   * (instrumentos y pistas con efectos) no pasa por el mezclador de Web Audio, así que aquí se
   * aplican también la automatización, el volumen del bus y el del master.
   */
  const syncMix = () => {
    const { tracks, buses, master, isPlaying } = useProject.getState();
    const { trackAudible } = audibility(tracks, buses);
    const pos = engine.position();
    const mix: Record<string, [number, boolean, number]> = {};
    for (const t of tracks) {
      const auto = isPlaying ? trackAutomation(t) : null;
      const bus = buses.find((b) => b.id === t.out);
      const volume = autoValue(auto?.volume, pos, t.volume) * master * (bus ? bus.volume : 1);
      mix[t.id] = [volume, trackAudible.get(t.id) ?? true, autoValue(auto?.pan, pos, t.pan)];
    }
    call("midi_set_mix", { mix });
  };

  // Mientras suena, seguir las envolventes
  setInterval(() => {
    const s = useProject.getState();
    if (s.isPlaying && s.tracks.some((t) => trackAutomation(t))) syncMix();
  }, 60);

  /** De qué dispositivo MIDI toma las notas cada pista ("" = cualquiera). */
  const syncMidiPorts = () => {
    const ports: Record<string, string> = {};
    for (const t of useProject.getState().tracks) ports[t.id] = t.midiPort ?? "";
    call("plugin_set_midi_ports", { ports });
  };

  syncClips();
  syncMix();
  syncMidiPorts();
  call("midi_set_offset", { ms: useMidi.getState().syncMs });

  useProject.subscribe((s, prev) => {
    if (s.clips !== prev.clips) syncClips();
    if (s.tracks !== prev.tracks || s.buses !== prev.buses || s.master !== prev.master) {
      syncMix();
      syncMidiPorts();
    }
  });
  useMidi.subscribe((s, prev) => {
    if (s.syncMs !== prev.syncMs) call("midi_set_offset", { ms: s.syncMs });
  });

  engine.onTransport((e) => {
    if (e.type === "start") call("midi_play", { position: e.position, delay: e.delay });
    else {
      call("midi_stop");
      setTimeout(syncMix, 120); // volver a los faders (cuando isPlaying ya se ha actualizado)
    }
  });
}
