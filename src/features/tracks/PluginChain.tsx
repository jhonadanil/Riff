import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Loader2, Plus, PowerOff, SquareArrowOutUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { refreshChains } from "@/audio/chains";
import { useNative } from "@/audio/native";
import { cn } from "@/lib/utils";

type Slot = {
  id: number;
  name: string;
  vendor: string;
  category: string;
  path: string;
  hasEditor: boolean;
  editorOpen: boolean;
  bypass: boolean;
};
type Available = { path: string; name: string };

/** La lista de plugins de una pista: añadir, abrir su ventana, saltar, ordenar y quitar. */
export function PluginChain({ trackId }: { trackId: string }) {
  const enabled = useNative((s) => s.available && s.enabled);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await invoke<Slot[]>("plugin_list", { track: trackId }).catch(() => []);
    setSlots(list);
    void refreshChains();
  }, [trackId]);

  useEffect(() => {
    void refresh();
    // Las ventanas de los plugins se cierran desde su propia ventana: ponerse al día
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const scan = () => run("scan", async () => setAvailable(await invoke<Available[]>("plugin_scan")));
  const add = (path: string) =>
    run("load", async () => {
      const slot = await invoke<Slot>("plugin_load", { track: trackId, path });
      if (slot.hasEditor) await invoke("plugin_editor", { id: slot.id, open: true });
    });

  return (
    <div className="grid gap-3">
      {!enabled && (
        <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
          Los plugins necesitan el <b>motor de baja latencia</b>: actívalo en Entrada de audio.
        </p>
      )}
      <Label className="text-xs text-muted-foreground">En orden de arriba abajo</Label>

      {slots.length > 0 && (
        <ul className="grid gap-1.5">
          {slots.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5">
              <div className={cn("min-w-0 flex-1", s.bypass && "opacity-50")}>
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">{s.vendor}</p>
              </div>
              {s.hasEditor && (
                <Button
                  size="icon-xs"
                  variant={s.editorOpen ? "secondary" : "ghost"}
                  aria-label={s.editorOpen ? "Cerrar la ventana del plugin" : "Abrir la ventana del plugin"}
                  onClick={() => run("editor", () => invoke("plugin_editor", { id: s.id, open: !s.editorOpen }))}
                >
                  <SquareArrowOutUpRight />
                </Button>
              )}
              <Button
                size="icon-xs"
                variant={s.bypass ? "secondary" : "ghost"}
                aria-label={s.bypass ? "Activar" : "Saltar este plugin"}
                aria-pressed={s.bypass}
                onClick={() => run("bypass", () => invoke("plugin_bypass", { id: s.id, on: !s.bypass }))}
              >
                <PowerOff />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Subir"
                disabled={i === 0}
                onClick={() => run("move", () => invoke("plugin_move", { id: s.id, dir: -1 }))}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Bajar"
                disabled={i === slots.length - 1}
                onClick={() => run("move", () => invoke("plugin_move", { id: s.id, dir: 1 }))}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Quitar"
                onClick={() => run("remove", () => invoke("plugin_remove", { id: s.id }))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        {available === null ? (
          <Button size="sm" variant="outline" onClick={scan} disabled={busy !== null}>
            {busy === "scan" ? <Loader2 className="animate-spin" /> : <Plus />}
            Añadir plugin
          </Button>
        ) : (
          <Select value="" onValueChange={(p) => void add(p)} disabled={busy !== null}>
            <SelectTrigger size="sm" className="w-full min-w-0">
              <SelectValue placeholder={available.length ? "Elige un plugin…" : "No se encontró ningún .vst3"} />
            </SelectTrigger>
            <SelectContent>
              {available.map((a) => (
                <SelectItem key={a.path} value={a.path}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {busy === "load" && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">{error}</p>}

      <p className="text-xs text-muted-foreground">
        Busca en <code>C:\Program Files\Common Files\VST3</code>. Se guardan con el proyecto. De momento solo se
        aplican a lo que escuchas al tocar, no a lo que grabas.
      </p>
    </div>
  );
}
