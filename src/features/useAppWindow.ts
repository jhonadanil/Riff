import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { useProject } from "@/store/project";
import { confirmDiscard, projectName, startAutosave } from "@/project/projectFile";

/** Título de la ventana, aviso al cerrar con cambios sin guardar y autoguardado. */
export function useAppWindow() {
  const projectPath = useProject((s) => s.projectPath);
  const dirty = useProject((s) => s.dirty);

  useEffect(() => {
    const title = `${dirty ? "• " : ""}${projectName(projectPath)} — Riff Studio`;
    document.title = title;
    if (isTauri()) getCurrentWindow().setTitle(title).catch(console.error);
  }, [projectPath, dirty]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await confirmDiscard())) e.preventDefault();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => startAutosave(), []);
}
