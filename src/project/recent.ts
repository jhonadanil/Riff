import { useSyncExternalStore } from "react";

/** Proyectos abiertos recientemente (rutas), guardados en el almacenamiento local de la app. */
const KEY = "riff.recentProjects";
const MAX = 10;

const listeners = new Set<() => void>();
let cache: string[] = read();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function write(list: string[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // sin almacenamiento: la lista vive solo en esta sesión
  }
  listeners.forEach((l) => l());
}

export function addRecent(path: string) {
  write([path, ...cache.filter((p) => p !== path)].slice(0, MAX));
}

export function removeRecent(path: string) {
  write(cache.filter((p) => p !== path));
}

export function clearRecent() {
  write([]);
}

export function useRecentProjects() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
  );
}
