import { appDataDir, join } from "@tauri-apps/api/path";
import { isTauri } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { useRecorder } from "@/audio/recorder";
import { useProject } from "@/store/project";
import { buildProjectFile, loadProjectFrom, projectName } from "./projectFile";

/**
 * Copia de recuperación: mientras hay cambios sin guardar (también en proyectos que nunca se han
 * guardado) se escribe una copia en la carpeta de datos de la app. Si la app se cierra de golpe,
 * al volver a abrirla se ofrece restaurarla. Guardar o cerrar con normalidad la borra.
 */

const EVERY_MS = 30 * 1000;

const folder = async () => join(await appDataDir(), "recovery");
const filePath = async () => join(await folder(), "recovery.riff");

/** Hasta que se resuelve la copia anterior no se escribe encima ni se borra. */
let ready = false;
let pending = false;
// Escribir y borrar, de uno en uno
let queue: Promise<unknown> = Promise.resolve();
const inOrder = <T>(task: () => Promise<T>) => {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
};

export function clearRecovery() {
  if (!ready) return Promise.resolve();
  pending = false;
  return inOrder(async () => {
    const dir = await folder();
    if (await exists(dir)) await remove(dir, { recursive: true });
  }).catch((err) => console.error("[recuperación] no se pudo borrar la copia", err));
}

function writeRecovery() {
  return inOrder(async () => {
    const { dirty, projectPath } = useProject.getState();
    if (!dirty) return;
    const dir = await folder();
    await mkdir(dir, { recursive: true });
    const file = await buildProjectFile(dir);
    await writeTextFile(await filePath(), JSON.stringify({ ...file, originalPath: projectPath }));
  });
}

/** Si quedó una copia de la sesión anterior, ofrece restaurarla. Devuelve false para no tocarla. */
async function offerRestore() {
  const path = await filePath();
  if (!(await exists(path))) return true;
  const answer = await message(
    "Riff Studio se cerró con cambios sin guardar. ¿Quieres recuperarlos?\n\nSi eliges «Ahora no», se te volverá a preguntar la próxima vez.",
    { title: "Recuperar proyecto", kind: "warning", buttons: { yes: "Recuperar", no: "Descartar", cancel: "Ahora no" } },
  );
  if (answer === "Descartar" || answer === "No") {
    await remove(await folder(), { recursive: true });
    return true;
  }
  if (answer !== "Recuperar" && answer !== "Yes") return false;
  const original = await loadProjectFrom(path, (file) => file.originalPath ?? null);
  // Sigue sin guardar: la copia se conserva hasta que se guarde
  useProject.setState({ dirty: true });
  toast.success(`«${projectName(original)}» recuperado`, { description: "Guárdalo para conservar los cambios." });
  return true;
}

/** Ha cambiado algo de los plugins (se guardan en el proyecto pero viven en el motor). */
export function markPluginsChanged() {
  useProject.setState({ dirty: true });
  pending = true;
}

let started = false;

export function startRecovery() {
  if (!isTauri() || started) return;
  started = true;

  useProject.subscribe((s, prev) => {
    if (prev.dirty && !s.dirty) void clearRecovery();
    else if (s.dirty && (s.clips !== prev.clips || s.tracks !== prev.tracks || s.bpm !== prev.bpm || s.buses !== prev.buses || s.master !== prev.master || !prev.dirty))
      pending = true;
  });

  offerRestore()
    .then((ok) => {
      ready = ok;
      if (!ok) return;
      setInterval(() => {
        const { isPlaying } = useProject.getState();
        // Ni sonando ni grabando, para no provocar cortes
        if (!pending || isPlaying || useRecorder.getState().phase !== "idle") return;
        pending = false;
        writeRecovery().catch((err) => {
          pending = true;
          console.error("[recuperación] no se pudo escribir la copia", err);
        });
      }, EVERY_MS);
    })
    .catch((err) => {
      console.error(err);
      toast.error("No se pudo recuperar el proyecto", { description: "La copia se conserva en la carpeta de datos de la app." });
    });
}
