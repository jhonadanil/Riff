import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppWindow, ChevronDown, ChevronUp, Loader2, Plus, Power, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { refreshChains } from "@/audio/chains";
import { useNative } from "@/audio/native";
import { cn } from "@/lib/utils";
import { markPluginsChanged } from "@/project/recovery";

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

/** La lista de plugins de una pista: encender y apagar, abrir su ventana, ordenar y quitar. */
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
      // Buscar plugins o abrir su ventana no cambia el proyecto
      if (label !== "scan" && !label.startsWith("editor-")) markPluginsChanged();
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
      <Label className="text-xs text-muted-foreground">Plugins, en orden de arriba abajo</Label>

      {slots.length > 0 && (
        <ul className="grid gap-2">
          {slots.map((s, i) => {
            const opening = busy === `editor-${s.id}`;
            return (
              <li
                key={s.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl border p-2 transition-colors",
                  s.bypass ? "border-dashed border-input" : "bg-muted/50",
                  s.editorOpen && "border-primary/60",
                )}
              >
                <Hint text={s.bypass ? "Encender el plugin" : "Apagar el plugin (la señal pasa sin él)"}>
                  <button
                    type="button"
                    aria-pressed={!s.bypass}
                    aria-label={`${s.name}: ${s.bypass ? "apagado" : "encendido"}`}
                    onClick={() => run("bypass", () => invoke("plugin_bypass", { id: s.id, on: !s.bypass }))}
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      s.bypass
                        ? "border-input text-muted-foreground hover:bg-muted hover:text-foreground"
                        : "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
                    )}
                  >
                    <Power className="size-4" />
                  </button>
                </Hint>

                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm font-medium", s.bypass && "text-muted-foreground")}>{s.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{s.bypass ? "Apagado" : s.vendor}</p>
                </div>

                {s.hasEditor && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-pressed={s.editorOpen}
                    disabled={opening}
                    title={s.editorOpen ? "Cerrar la ventana del plugin" : "Abrir la ventana del plugin"}
                    className={cn(
                      "w-23 shrink-0",
                      s.editorOpen && "border-primary/60 bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary dark:border-primary/60 dark:bg-primary/15 dark:hover:bg-primary/25",
                    )}
                    onClick={() => run(`editor-${s.id}`, () => invoke("plugin_editor", { id: s.id, open: !s.editorOpen }))}
                  >
                    {opening ? <Loader2 className="animate-spin" /> : <AppWindow />}
                    {s.editorOpen ? "Abierta" : "Abrir"}
                  </Button>
                )}

                <div className="flex shrink-0 flex-col">
                  <MoveButton
                    label="Subir"
                    disabled={i === 0}
                    onClick={() => run("move", () => invoke("plugin_move", { id: s.id, dir: -1 }))}
                  >
                    <ChevronUp className="size-3.5" />
                  </MoveButton>
                  <MoveButton
                    label="Bajar"
                    disabled={i === slots.length - 1}
                    onClick={() => run("move", () => invoke("plugin_move", { id: s.id, dir: 1 }))}
                  >
                    <ChevronDown className="size-3.5" />
                  </MoveButton>
                </div>

                <Hint text="Quitar de la pista">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Quitar ${s.name}`}
                    className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive dark:hover:bg-destructive/20"
                    onClick={() => run("remove", () => invoke("plugin_remove", { id: s.id }))}
                  >
                    <X />
                  </Button>
                </Hint>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-2">
        {available === null ? (
          <Button variant="outline" className="w-full border-dashed" onClick={scan} disabled={busy !== null}>
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
        Busca en <code>C:\Program Files\Common Files\VST3</code>. Se guardan con el proyecto. Los efectos se oyen al tocar,
        al reproducir y al exportar. Al reproducir, una pista con efectos todavía no pasa por sus envíos ni mueve su
        medidor; la exportación sí aplica los envíos.
      </p>
    </div>
  );
}

function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function MoveButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-4.5 w-6 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
