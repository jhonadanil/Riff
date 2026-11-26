import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTrackKind, useTrackPluginCount } from "@/audio/chains";
import { useNative } from "@/audio/native";
import { cn } from "@/lib/utils";
import type { Track } from "@/store/project";
import { PluginChain } from "./PluginChain";
import { TrackMidiPort } from "./TrackMidi";
import { TrackInput, TrackRecordFx } from "./TrackInput";

/** Botón de la cabecera de pista: abre la cadena de plugins de esa pista. */
export function TrackPluginsButton({ track }: { track: Track }) {
  const [open, setOpen] = useState(false);
  const native = useNative((s) => s.available);
  const count = useTrackPluginCount(track.id);
  const kind = useTrackKind(track.id);
  if (!native) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(
              "relative",
              count > 0 && "bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary dark:hover:bg-primary/25",
              open && "ring-2 ring-primary/60",
            )}
            onClick={() => setOpen(true)}
            aria-label={`Entrada y plugins de ${track.name}${count > 0 ? ` (${count} plugins)` : ""}`}
          >
            <Plug />
            {count > 0 && (
              <span className="absolute -top-1 -right-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground tabular-nums">
                {count}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Entrada y plugins VST3 de la pista</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>«{track.name}»</DialogTitle>
            <DialogDescription>De dónde toma el sonido y qué plugins lleva.</DialogDescription>
          </DialogHeader>
          {kind === "midi" ? (
            <TrackMidiPort track={track} />
          ) : (
            <>
              <TrackInput track={track} />
              <details className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium select-none">Avanzado</summary>
                <div className="mt-3">
                  <TrackRecordFx track={track} />
                </div>
              </details>
            </>
          )}
          <PluginChain trackId={track.id} />
        </DialogContent>
      </Dialog>
    </>
  );
}
