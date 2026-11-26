import { invoke, isTauri } from "@tauri-apps/api/core";
import { useProject, type Clip } from "@/store/project";
import { useChains } from "./chains";
import * as engine from "./engine";
import { useNative } from "./native";

/**
 * Hace que lo grabado en una pista con efectos suene por sus plugins al reproducir.
 *
 * Con el motor de baja latencia encendido, el audio "limpio" de esas pistas se junta en una sola
 * tira (de principio a fin de la canción) y se entrega al motor nativo, que lo pasa por la cadena
 * mientras suena. Web Audio deja entonces de tocar esos clips. Las tomas grabadas "con efectos"
 * ya los llevan puestos y siguen sonando por Web Audio.
 */

if (isTauri()) {
  /** Lo que tiene cargado el motor: pista -> huella de lo que se le mandó. */
  const sent = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const send = (trackId: string, data: Float32Array, rate: number) =>
    invoke("track_set_audio", new Uint8Array(data.buffer), { headers: { "x-track": trackId, "x-rate": String(rate) } });

  async function sync() {
    const { status, info } = useNative.getState();
    const { tracks, clips } = useProject.getState();
    const wanted = new Map<string, Clip[]>();
    if (status === "on" && info) {
      for (const t of tracks) {
        if (!engine.hasEffects(t.id)) continue;
        const dry = engine.dryClips(clips, t.id);
        if (dry.length) wanted.set(t.id, dry);
      }
    }

    // Retirar las que ya no tocan (y devolver sus clips a Web Audio)
    for (const id of sent.keys()) {
      if (wanted.has(id)) continue;
      sent.delete(id);
      engine.setNativeTracks(new Set(sent.keys()));
      await send(id, new Float32Array(0), 0);
    }

    for (const [id, dry] of wanted) {
      const rate = info!.sampleRate;
      const print = `${rate}|${dry.map(engine.clipKey).join(";")}`;
      if (sent.get(id) === print) continue;
      await send(id, await engine.renderDry(dry, rate), rate);
      sent.set(id, print);
      engine.setNativeTracks(new Set(sent.keys()));
    }
  }

  // Los cambios llegan a ráfagas (arrastrar un clip): se espera un poco y se aplican en orden
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(sync).catch((err) => console.error("[efectos] no se pudo preparar el audio de las pistas", err));
    }, 150);
  };

  useProject.subscribe((s, prev) => {
    if (s.clips !== prev.clips || s.tracks !== prev.tracks) schedule();
  });
  useChains.subscribe(schedule);
  useNative.subscribe((s, prev) => {
    if (s.status !== prev.status || s.info !== prev.info) schedule();
  });
  schedule();
}
