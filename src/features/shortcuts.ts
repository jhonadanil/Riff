import { useEffect } from "react";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";
import { toggleRecord, stopRecording, useRecorder } from "@/audio/recorder";
import { exportWav, newProject, openProject, saveProject, saveProjectAs } from "@/project/projectFile";

export async function togglePlay() {
  // Grabando (o en la cuenta previa): Espacio para la toma
  if (useRecorder.getState().phase !== "idle") return stopRecording();
  const { isPlaying, setPlaying } = useProject.getState();
  if (isPlaying) engine.pause();
  else await engine.play();
  setPlaying(!isPlaying);
}

/**
 * Atajos de teclado globales:
 * Espacio play/pausa · R grabar/parar · C cuenta previa · Inicio volver al inicio · S dividir · Supr borrar clip
 * Ctrl+Z deshacer · Ctrl+Y / Ctrl+Shift+Z rehacer · M metrónomo · L loop · G rejilla
 * Ctrl+C copiar · Ctrl+V pegar en el cursor · Ctrl+D duplicar · Ctrl+A seleccionar todo
 * Ctrl+N nuevo · Ctrl+O abrir · Ctrl+S guardar · Ctrl+Shift+S guardar como · Ctrl+I importar · Ctrl+E exportar
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      const s = useProject.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      let handled = true;
      if (ctrl && key === "n") newProject();
      else if (ctrl && key === "o") openProject();
      else if (ctrl && key === "s") (e.shiftKey ? saveProjectAs : saveProject)();
      else if (ctrl && key === "i") document.getElementById("import-audio-input")?.click();
      else if (ctrl && key === "e") exportWav();
      else if (ctrl && key === "c") handled = s.copySelection();
      else if (ctrl && key === "v") s.paste(engine.position(), s.selectedTrackId);
      else if (ctrl && key === "d") s.duplicateSelection();
      else if (ctrl && key === "a") s.selectAllClips();
      else if (ctrl && key === "z" && !e.shiftKey) s.undo();
      else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) s.redo();
      else if (ctrl || e.altKey) handled = false;
      else if (e.code === "Space") togglePlay();
      else if (key === "r" && !e.repeat) toggleRecord();
      else if (key === "c") s.toggleCountIn();
      else if (e.key === "Home") engine.seek(0);
      else if (key === "s") s.splitAt(engine.position());
      else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedClipIds.length) s.removeClips(s.selectedClipIds);
      else if (key === "m") s.toggleMetronome();
      else if (key === "l") s.toggleLoop();
      else if (key === "g") s.toggleSnap();
      else if (e.key === "Escape") (s.editingClipId ? s.openPianoRoll(null) : s.selectClip(null));
      else handled = false;

      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
