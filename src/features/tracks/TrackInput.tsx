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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { trackInput, useInput } from "@/audio/input";
import { cn } from "@/lib/utils";
import { useProject, type Track } from "@/store/project";

const INPUT_LABEL = { "1": "Entrada 1", "2": "Entrada 2", stereo: "Entradas 1 + 2 (estéreo)" } as const;
const DEFAULT_INPUT = "__default";

/** Selector rápido de la entrada de la pista, para la cabecera: 1, 2 o 1+2. */
export function TrackInputMenu({ track }: { track: Track }) {
  const channel = useInput((s) => s.channel);
  const current = trackInput(track);
  const short = { "1": "1", "2": "2", stereo: "1+2" } as const;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className={cn("px-1.5 font-mono text-[11px] tabular-nums", !track.input && "text-muted-foreground")}
              aria-label={`Entrada de ${track.name}: ${INPUT_LABEL[current]}`}
            >
              {short[current]}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Entrada de la interfaz: {INPUT_LABEL[current]}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>Entrada de esta pista</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={track.input ?? DEFAULT_INPUT}
          onValueChange={(v) =>
            useProject.getState().updateTrack(track.id, { input: v === DEFAULT_INPUT ? undefined : (v as Track["input"]) })
          }
        >
          <DropdownMenuRadioItem value={DEFAULT_INPUT}>Predeterminada ({INPUT_LABEL[channel]})</DropdownMenuRadioItem>
          {(Object.keys(INPUT_LABEL) as (keyof typeof INPUT_LABEL)[]).map((k) => (
            <DropdownMenuRadioItem key={k} value={k}>
              {INPUT_LABEL[k]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** De qué entrada de la interfaz toma el sonido esta pista (al escucharse y al grabar). */
export function TrackInput({ track }: { track: Track }) {
  const channel = useInput((s) => s.channel);
  const current = trackInput(track);
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">Entrada</Label>
      <Select
        value={track.input ?? DEFAULT_INPUT}
        onValueChange={(v) => useProject.getState().updateTrack(track.id, { input: v === DEFAULT_INPUT ? undefined : (v as Track["input"]) })}
      >
        <SelectTrigger size="sm" className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_INPUT}>Predeterminada ({INPUT_LABEL[channel]})</SelectItem>
          {(Object.keys(INPUT_LABEL) as (keyof typeof INPUT_LABEL)[]).map((k) => (
            <SelectItem key={k} value={k}>
              {INPUT_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Usa {INPUT_LABEL[current]}. Para grabar guitarra y voz a la vez, pon cada pista en su entrada (en una Scarlett
        Solo, el micro es la 1 y el instrumento la 2).
      </p>
    </div>
  );
}

/** Grabar la pista ya con sus plugins puestos (el ampli) en vez de la señal limpia. */
export function TrackRecordFx({ track }: { track: Track }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1">
        <Label htmlFor={`fx-${track.id}`} className="text-sm font-medium">
          Grabar con los efectos
        </Label>
        <p className="text-xs text-muted-foreground">
          Se guarda lo que sale de los plugins de la pista (por ejemplo la guitarra ya con el ampli), sin poder cambiarlo
          después. Apagado, se guarda la señal limpia. Necesita el motor de baja latencia y al menos un plugin de efectos.
        </p>
      </div>
      <Switch
        id={`fx-${track.id}`}
        checked={track.recordFx === true}
        onCheckedChange={(v) => useProject.getState().updateTrack(track.id, { recordFx: v || undefined })}
      />
    </div>
  );
}
