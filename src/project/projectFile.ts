import { message, open, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { dirname, join } from "@tauri-apps/api/path";
import { toast } from "sonner";
import * as engine from "@/audio/engine";
import { emptyProject, useProject, type ProjectData } from "@/store/project";
import { addRecent, removeRecent } from "./recent";

/**
 * Formato en disco:
 *   Mi canción.riff   JSON con pistas, clips y ajustes
 *   Audio/            los audios del proyecto, nombrados por su id
 * Varios proyectos pueden compartir carpeta (y su carpeta Audio).
 */
const FORMAT_VERSION = 1;
const AUDIO_DIR = "Audio";

type RiffFile = ProjectData & {
  format: "riff";
  version: number;
  /** bufferId -> nombre de archivo dentro de Audio/ */
  audio: Record<string, string>;
};

export const projectName = (path: string | null) =>
  path ? path.split(/[\\/]/).pop()!.replace(/\.riff$/i, "") : "Sin título";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Si hay cambios sin guardar, pregunta. Devuelve false si el usuario cancela. */
export async function confirmDiscard(): Promise<boolean> {
  const { dirty, projectPath } = useProject.getState();
  if (!dirty) return true;
  const answer = await message(`¿Guardar los cambios de «${projectName(projectPath)}» antes de continuar?`, {
    title: "Riff",
    kind: "warning",
    buttons: { yes: "Guardar", no: "No guardar", cancel: "Cancelar" },
  });
  if (answer === "Guardar" || answer === "Yes") return saveProject();
  return answer === "No guardar" || answer === "No";
}

function stopPlayback() {
  engine.pause();
  engine.seek(0);
  useProject.getState().setPlaying(false);
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  stopPlayback();
  useProject.getState().loadProject(emptyProject(), null);
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  const chosen =
    path ??
    (await open({ title: "Abrir proyecto", filters: [{ name: "Proyecto de Riff", extensions: ["riff"] }] }));
  if (typeof chosen !== "string") return;

  const id = toast.loading(`Abriendo «${projectName(chosen)}»…`);
  try {
    const file = JSON.parse(await readTextFile(chosen)) as RiffFile;
    if (file.format !== "riff") throw new Error("No es un proyecto de Riff");
    if (file.version > FORMAT_VERSION) throw new Error("El proyecto es de una versión más nueva de Riff");

    const audioDir = await join(await dirname(chosen), AUDIO_DIR);
    const missing: string[] = [];
    for (const [bufferId, fileName] of Object.entries(file.audio)) {
      if (engine.hasBuffer(bufferId)) continue;
      const audioPath = await join(audioDir, fileName);
      try {
        const bytes = await readFile(audioPath);
        await engine.loadBuffer(bufferId, bytes, fileName.split(".").pop() ?? "wav");
      } catch {
        missing.push(fileName);
      }
    }

    const clips = file.clips.filter((c) => engine.hasBuffer(c.bufferId));
    stopPlayback();
    useProject.getState().loadProject(
      { bpm: file.bpm, tracks: file.tracks, clips, loop: file.loop, loopEnabled: file.loopEnabled },
      chosen,
    );
    addRecent(chosen);
    if (missing.length) {
      toast.warning(`Faltan ${missing.length} audio(s)`, {
        id,
        description: `No se encontraron en ${audioDir}. Sus clips se han quitado.`,
      });
    } else {
      toast.success(`«${projectName(chosen)}» abierto`, { id });
    }
  } catch (err) {
    console.error(err);
    if (path) removeRecent(path);
    toast.error("No se pudo abrir el proyecto", { id, description: errorText(err) });
  }
}

/** Guarda en la ruta actual (o pregunta dónde si es nuevo). Devuelve true si se guardó. */
export async function saveProject(): Promise<boolean> {
  const { projectPath } = useProject.getState();
  return projectPath ? writeProject(projectPath) : saveProjectAs();
}

export async function saveProjectAs(): Promise<boolean> {
  const path = await save({
    title: "Guardar proyecto",
    defaultPath: `${projectName(useProject.getState().projectPath)}.riff`,
    filters: [{ name: "Proyecto de Riff", extensions: ["riff"] }],
  });
  if (!path) return false;
  return writeProject(path.toLowerCase().endsWith(".riff") ? path : `${path}.riff`);
}

async function writeProject(path: string, quiet = false): Promise<boolean> {
  const s = useProject.getState();
  try {
    const audioDir = await join(await dirname(path), AUDIO_DIR);
    await mkdir(audioDir, { recursive: true });

    const audio: Record<string, string> = {};
    for (const bufferId of new Set(s.clips.map((c) => c.bufferId))) {
      const src = engine.getSource(bufferId);
      if (!src) continue;
      const fileName = `${bufferId}.${src.ext}`;
      const filePath = await join(audioDir, fileName);
      // Los audios no cambian nunca: si ya están en disco no hace falta reescribirlos
      if (!(await exists(filePath))) await writeFile(filePath, src.bytes);
      audio[bufferId] = fileName;
    }

    const file: RiffFile = {
      format: "riff",
      version: FORMAT_VERSION,
      bpm: s.bpm,
      tracks: s.tracks,
      clips: s.clips,
      loop: s.loop,
      loopEnabled: s.loopEnabled,
      audio,
    };
    await writeTextFile(path, JSON.stringify(file, null, 2));
    useProject.getState().markSaved(path);
    addRecent(path);
    if (!quiet) toast.success(`Guardado «${projectName(path)}»`);
    return true;
  } catch (err) {
    console.error(err);
    toast.error("No se pudo guardar", { description: errorText(err) });
    return false;
  }
}

export async function exportWav() {
  const { clips, projectPath } = useProject.getState();
  if (!clips.length) {
    toast.info("No hay nada que exportar", { description: "Importa algo de audio primero." });
    return;
  }
  const path = await save({
    title: "Exportar mezcla",
    defaultPath: `${projectName(projectPath)}.wav`,
    filters: [{ name: "Audio WAV", extensions: ["wav"] }],
  });
  if (!path) return;

  const id = toast.loading("Exportando mezcla…");
  try {
    const wav = await engine.renderMixToWav();
    await writeFile(path, wav);
    toast.success("Mezcla exportada", { id, description: path });
  } catch (err) {
    console.error(err);
    toast.error("No se pudo exportar", { id, description: errorText(err) });
  }
}

// --- Autoguardado -----------------------------------------------------------

const AUTOSAVE_MS = 2 * 60 * 1000;

/** Guarda solo cada pocos minutos si el proyecto ya tiene archivo y hay cambios. */
export function startAutosave() {
  const timer = setInterval(() => {
    const { projectPath, dirty, isPlaying } = useProject.getState();
    // No guardar mientras suena para no provocar cortes
    if (projectPath && dirty && !isPlaying) writeProject(projectPath, true);
  }, AUTOSAVE_MS);
  return () => clearInterval(timer);
}
