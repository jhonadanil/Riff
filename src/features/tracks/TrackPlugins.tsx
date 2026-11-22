import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTrackKind, useTrackPluginCount } from "@/audio/chains";
import { useNative } from "@/audio/native";
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
            variant={count > 0 ? "secondary" : "ghost"}
            onClick={() => setOpen(true)}
            aria-label={`Entrada y plugins de ${track.name}`}
          >
            <Plug />
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
