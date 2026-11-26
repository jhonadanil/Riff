import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { restartNative } from "@/audio/native";
import { confirmDiscard } from "@/project/projectFile";
import { clearRecovery } from "@/project/recovery";

/** Actualizaciones desde las releases de GitHub (configurado en src-tauri/tauri.conf.json). */

async function install(update: Update) {
  if (!(await confirmDiscard())) return;
  await clearRecovery();
  const id = toast.loading(`Descargando la versión ${update.version}…`);
  try {
    await update.download();
    // Soltar el driver de audio antes de que el instalador cierre la app (sin cambiar la preferencia)
    await invoke("audio_stop").catch(() => {});
    await update.install();
    await relaunch();
  } catch (err) {
    console.error(err);
    void restartNative();
    toast.error("No se pudo actualizar", { id, description: String(err) });
  }
}

/** Busca una versión nueva. Con `manual` (desde el menú) avisa también si no hay o si falla. */
export async function checkForUpdates(manual = false) {
  if (!isTauri()) return;
  try {
    const update = await check();
    if (!update) {
      if (manual) toast.success("Tienes la última versión");
      return;
    }
    toast.info(`Hay una versión nueva: ${update.version}`, {
      duration: Infinity,
      closeButton: true,
      action: { label: "Instalar y reiniciar", onClick: () => void install(update) },
    });
  } catch (err) {
    console.error(err);
    if (manual) toast.error("No se pudo buscar actualizaciones", { description: String(err) });
  }
}
