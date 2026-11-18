import { useEffect } from "react";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";

export async function togglePlay() {
  const { isPlaying, setPlaying } = useProject.getState();
  if (isPlaying) engine.pause();
  else await engine.play();
  setPlaying(!isPlaying);
}

/**
 * Atajos de teclado globales:
 * Espacio play/pausa · Inicio volver al inicio · S dividir · Supr borrar clip
 * Ctrl+Z deshacer · Ctrl+Y / Ctrl+Shift+Z rehacer · M metrónomo · L loop · G rejilla
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
      if (ctrl && key === "z" && !e.shiftKey) s.undo();
      else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) s.redo();
      else if (ctrl || e.altKey) handled = false;
      else if (e.code === "Space") togglePlay();
      else if (e.key === "Home") engine.seek(0);
      else if (key === "s") s.splitAt(engine.position());
      else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedClipId) s.removeClip(s.selectedClipId);
      else if (key === "m") s.toggleMetronome();
      else if (key === "l") s.toggleLoop();
      else if (key === "g") s.toggleSnap();
      else if (e.key === "Escape") s.selectClip(null);
      else handled = false;

      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
