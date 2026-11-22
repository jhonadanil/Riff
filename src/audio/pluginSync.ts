import { invoke } from "@tauri-apps/api/core";
import { useProject } from "@/store/project";
import { audibleMonitored, channelIndex, trackInput, useInput } from "./input";
import { useNative } from "./native";

/**
 * Le dice al motor nativo (la cadena de plugins) lo que necesita saber de las pistas:
 * cuáles se escuchan, cuáles están armadas y de qué entrada toma el sonido cada una.
 *
 * Los plugins de pistas borradas NO se descargan aquí: deshacer debe poder devolverlos;
 * se limpian al guardar el proyecto (src/project/projectFile.ts).
 */

const available = () => useNative.getState().available;

/** Pistas que se escuchan (con los auriculares); callan si el monitor está silenciado. */
export function syncMonitored() {
  if (!available()) return;
  void invoke("plugin_set_monitored", { tracks: audibleMonitored(useInput.getState()) }).catch(console.error);
}

/** Las pistas armadas (sus instrumentos suenan al tocarlos); callan si el monitor está silenciado. */
export function syncArmed() {
  if (!available()) return;
  const tracks = useInput.getState().monitorMuted ? [] : useProject.getState().tracks.filter((t) => t.armed).map((t) => t.id);
  void invoke("plugin_set_armed", { tracks }).catch(console.error);
}

/** Cada pista le dice al motor de qué entrada de la interfaz toma el sonido. */
export function syncTrackInputs() {
  if (!available()) return;
  const inputs: Record<string, number> = {};
  for (const t of useProject.getState().tracks) inputs[t.id] = channelIndex(trackInput(t));
  void invoke("plugin_set_inputs", { inputs }).catch(console.error);
}

useInput.subscribe((s, prev) => {
  if (s.channel !== prev.channel) syncTrackInputs();
  if (s.monitorMuted !== prev.monitorMuted) syncArmed();
  if (s.monitored !== prev.monitored || s.monitorMuted !== prev.monitorMuted) syncMonitored();
});

useProject.subscribe((state, prev) => {
  if (state.tracks === prev.tracks || !available()) return;
  if (state.tracks.some((t) => t.armed !== prev.tracks.find((p) => p.id === t.id)?.armed)) syncArmed();
  if (state.tracks.some((t, i) => t.input !== prev.tracks.find((p) => p.id === t.id)?.input || i >= prev.tracks.length)) {
    syncTrackInputs();
  }
});

syncTrackInputs();
syncArmed();
