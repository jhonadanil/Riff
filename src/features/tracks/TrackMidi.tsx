import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMidi } from "@/audio/midi";
import { cn } from "@/lib/utils";
import { useProject, type Track } from "@/store/project";

const ANY_MIDI = "__any";

/** Selector rápido del controlador MIDI de una pista con instrumento, para la cabecera. */
export function TrackMidiMenu({ track }: { track: Track }) {
  const enabled = useMidi((s) => s.enabled);
  const list = track.midiPort && !enabled.includes(track.midiPort) ? [...enabled, track.midiPort] : enabled;
  const label = track.midiPort ?? "Cualquier controlador";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className={cn("px-1.5 font-mono text-[11px]", !track.midiPort && "text-muted-foreground")}
              aria-label={`Entrada MIDI de ${track.name}: ${label}`}
            >
              MIDI
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Entrada MIDI: {label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>Entrada MIDI de esta pista</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={track.midiPort ?? ANY_MIDI}
          onValueChange={(v) => useProject.getState().updateTrack(track.id, { midiPort: v === ANY_MIDI ? undefined : v })}
        >
          <DropdownMenuRadioItem value={ANY_MIDI}>Cualquier controlador</DropdownMenuRadioItem>
          {list.map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {p}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {list.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Activa un controlador en Entrada de audio › Controladores MIDI.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** De qué controlador MIDI toma las notas esta pista (útil si hay más de uno). */
export function TrackMidiPort({ track }: { track: Track }) {
  const enabled = useMidi((s) => s.enabled);
  const list = track.midiPort && !enabled.includes(track.midiPort) ? [...enabled, track.midiPort] : enabled;
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">Entrada</Label>
      <Select
        value={track.midiPort ?? ANY_MIDI}
        onValueChange={(v) => useProject.getState().updateTrack(track.id, { midiPort: v === ANY_MIDI ? undefined : v })}
      >
        <SelectTrigger size="sm" className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_MIDI}>Cualquier controlador</SelectItem>
          {list.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Esta pista lleva un instrumento: toca las notas del controlador MIDI que elijas, no recibe audio de la
        interfaz. {enabled.length === 0 && "Activa un controlador en Entrada de audio › Controladores MIDI."}
      </p>
    </div>
  );
}
