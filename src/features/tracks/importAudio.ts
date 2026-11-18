import { toast } from "sonner";
import { decodeFile } from "@/audio/engine";
import { useProject } from "@/store/project";

const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a|aac|aiff?|webm)$/i;

export function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
}

/**
 * Decodifica los archivos y los coloca como clips en la pista indicada,
 * uno detrás de otro a partir de `start` (segundos).
 */
export async function importAudioFiles(files: Iterable<File>, trackId: string, start: number) {
  let at = Math.max(0, start);
  for (const file of files) {
    if (!isAudioFile(file)) {
      toast.error(`"${file.name}" no es un archivo de audio`);
      continue;
    }
    try {
      const { bufferId, duration } = await decodeFile(file);
      useProject.getState().addClip({
        id: crypto.randomUUID(),
        trackId,
        name: file.name.replace(/\.[^.]+$/, ""),
        start: at,
        duration,
        bufferId,
      });
      at += duration;
    } catch (err) {
      console.error(err);
      toast.error(`No se pudo leer "${file.name}"`, { description: "Formato no soportado o archivo dañado." });
    }
  }
}
