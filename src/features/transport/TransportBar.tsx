import { useEffect, useRef, type ReactNode } from "react";
import { Circle, FileAudio, Hourglass, Magnet, Pause, Play, Redo2, Repeat, SkipBack, Timer, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { beatSeconds, TIME_SIGS, useProject, type TimeSig } from "@/store/project";
import * as engine from "@/audio/engine";
import { importAudioFiles } from "@/features/tracks/importAudio";
import { togglePlay } from "@/features/shortcuts";
import { countInRemaining, toggleRecord, useRecorder } from "@/audio/recorder";
import { projectName } from "@/project/projectFile";
import { cn } from "@/lib/utils";
import { FileMenu } from "./FileMenu";
import { InputButton } from "@/features/input/InputDialog";
import { SettingsMenu } from "@/features/theme/ThemeMenu";

/** Envuelve un control con un tooltip que muestra su nombre y atajo. */
function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TransportBar() {
  const s = useProject();
  const phase = useRecorder((r) => r.phase);
  const recording = phase !== "idle";
  const fileInput = useRef<HTMLInputElement>(null);

  // El audio importado va a la pista seleccionada (o a la primera si no hay ninguna)
  const target = s.tracks.find((t) => t.id === s.selectedTrackId) ?? s.tracks[0];

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const { selectedTrackId, tracks } = useProject.getState();
    const track = tracks.find((t) => t.id === selectedTrackId) ?? tracks[0];
    if (!track) return;
    const before = useProject.getState().clips.length;
    await importAudioFiles(Array.from(files), track.id, engine.position());
    if (useProject.getState().clips.length > before) {
      useProject.getState().selectTrack(track.id);
      toast.success(`Importado en «${track.name}»`);
    }
  };

  return (
    <header className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b px-4">
      {/* Izquierda: proyecto */}
      <div className="flex min-w-0 items-center gap-2">
        <FileMenu onImportAudio={() => fileInput.current?.click()} />
        <span className="min-w-0 truncate text-sm text-muted-foreground" title={s.projectPath ?? undefined}>
          {projectName(s.projectPath)}
          {s.dirty && <span aria-label="cambios sin guardar"> •</span>}
        </span>
        <div className="ml-1 flex items-center">
          <Tip label="Deshacer (Ctrl+Z)">
            <Button variant="ghost" size="icon-sm" onClick={s.undo} disabled={!s.past.length} aria-label="Deshacer">
              <Undo2 />
            </Button>
          </Tip>
          <Tip label="Rehacer (Ctrl+Y)">
            <Button variant="ghost" size="icon-sm" onClick={s.redo} disabled={!s.future.length} aria-label="Rehacer">
              <Redo2 />
            </Button>
          </Tip>
        </div>
      </div>

      {/* Centro: transporte */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-full bg-muted p-1">
          <Tip label="Volver al inicio (Inicio)">
            <Button variant="ghost" size="icon" className="hover:bg-raised" onClick={() => engine.seek(0)} aria-label="Volver al inicio">
              <SkipBack />
            </Button>
          </Tip>
          <Tip label={`${s.isPlaying ? "Pausar" : "Reproducir"} (Espacio)`}>
            <Button
              size="icon-lg"
              className="hover:bg-primary/85"
              onClick={togglePlay}
              aria-label={s.isPlaying ? "Pausar" : "Reproducir"}
            >
              {s.isPlaying ? <Pause className="fill-current" /> : <Play className="translate-x-px fill-current" />}
            </Button>
          </Tip>
          <Tip label={recording ? "Parar la grabación (R)" : "Grabar en las pistas armadas (R)"}>
            <Button
              variant="ghost"
              size="icon"
              className={cn("hover:bg-raised", recording && "bg-rec/15 hover:bg-rec/25")}
              onClick={() => void toggleRecord()}
              aria-label={recording ? "Parar la grabación" : "Grabar"}
              aria-pressed={recording}
            >
              <Circle
                className={cn(
                  "size-3.5 fill-current text-rec",
                  !recording && "opacity-80",
                  phase === "countin" && "animate-pulse",
                )}
              />
            </Button>
          </Tip>
        </div>

        <TimeDisplay />

        <label className="flex h-11 items-center gap-2 rounded-full bg-muted pr-1 pl-4 text-xs font-medium text-muted-foreground">
          BPM
          <Input
            type="number"
            className="h-9 w-16 border-0 bg-raised text-center font-medium text-foreground tabular-nums shadow-raised dark:bg-raised"
            defaultValue={s.bpm}
            key={s.bpm}
            min={20}
            max={300}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v >= 20 && v <= 300) s.setBpm(v);
              else e.target.value = String(s.bpm);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
      </div>

      {/* Derecha: ayudas, entrada, atajos y tema */}
      <div className="flex items-center justify-end gap-2">
        <div className="flex items-center gap-0.5 rounded-full bg-muted p-1">
          <MetronomeToggle />
          <Tip label="Cuenta previa de un compás al grabar (C)">
            <Toggle className={pillToggle} pressed={s.countIn} onPressedChange={s.toggleCountIn} aria-label="Cuenta previa">
              <Hourglass />
            </Toggle>
          </Tip>
          <Tip label={s.loop ? "Loop (L)" : "Loop (L) · arrastra en la regla para crear la región"}>
            <Toggle className={pillToggle} pressed={s.loopEnabled} onPressedChange={s.toggleLoop} disabled={!s.loop} aria-label="Loop">
              <Repeat />
            </Toggle>
          </Tip>
          <Tip label="Ajustar a la rejilla (G)">
            <Toggle className={pillToggle} pressed={s.snap} onPressedChange={s.toggleSnap} aria-label="Ajustar a la rejilla">
              <Magnet />
            </Toggle>
          </Tip>
        </div>

        <InputButton />

        <input
          ref={fileInput}
          id="import-audio-input"
          type="file"
          accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff"
          multiple
          hidden
          onChange={(e) => {
            onImport(e.target.files);
            e.target.value = "";
          }}
        />
        <Tip label={target ? `Se importa en la pista «${target.name}» (selecciona otra pista para cambiarla), donde está el cursor` : "Importar audio"}>
          <Button variant="outline" onClick={() => fileInput.current?.click()} className="h-9 max-w-64 px-4">
            <FileAudio />
            <span className="truncate">{target ? `Importar a «${target.name}»` : "Importar audio"}</span>
          </Button>
        </Tip>
        <SettingsMenu />
      </div>
    </header>
  );
}

/** Metrónomo: clic para activarlo; clic derecho para elegir el compás, el volumen y la subdivisión. */
function MetronomeToggle() {
  const { metronome, toggleMetronome, timeSig, setTimeSig, click, setClick } = useProject();
  const sigValue = timeSig.join("/");

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <Toggle className={pillToggle} pressed={metronome} onPressedChange={toggleMetronome} aria-label="Metrónomo">
              <Timer />
            </Toggle>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Metrónomo (M) · {sigValue}</TooltipContent>
      </Tooltip>
      <ContextMenuContent className="min-w-48">
        <ContextMenuLabel>Compás</ContextMenuLabel>
        <ContextMenuRadioGroup
          value={sigValue}
          onValueChange={(v) => setTimeSig(v.split("/").map(Number) as TimeSig)}
        >
          {TIME_SIGS.map((sig) => (
            <ContextMenuRadioItem key={sig.join("/")} value={sig.join("/")}>
              {sig.join("/")}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuLabel>Volumen del click</ContextMenuLabel>
        <ContextMenuRadioGroup value={String(click.volume)} onValueChange={(v) => setClick({ volume: Number(v) })}>
          <ContextMenuRadioItem value="-20">Bajo</ContextMenuRadioItem>
          <ContextMenuRadioItem value="-10">Medio</ContextMenuRadioItem>
          <ContextMenuRadioItem value="-4">Alto</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={click.eighths} onCheckedChange={(v) => setClick({ eighths: v === true })}>
          Subdividir (clic a medios tiempos)
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Conmutador dentro de un grupo gris: el activo se "levanta" en blanco (o gris claro en oscuro). */
const pillToggle =
  "size-9 rounded-full text-muted-foreground hover:bg-raised/70 hover:text-foreground data-[state=on]:bg-raised data-[state=on]:text-foreground data-[state=on]:shadow-raised aria-pressed:bg-raised";

/** Posición actual (min:seg y compás.tiempo), actualizada cada frame. */
function TimeDisplay() {
  const ref = useRef<HTMLSpanElement>(null);
  const bpm = useProject((s) => s.bpm);
  const timeSig = useProject((s) => s.timeSig);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const left = countInRemaining();
      if (left !== null) {
        if (ref.current) ref.current.textContent = `Cuenta  ·  ${left}`;
        raf = requestAnimationFrame(tick);
        return;
      }
      const s = engine.position();
      const beat = s / beatSeconds(bpm, timeSig);
      const bar = Math.floor(beat / timeSig[0]) + 1;
      const beatInBar = Math.floor(beat % timeSig[0]) + 1;
      const min = Math.floor(s / 60);
      const sec = (s % 60).toFixed(1).padStart(4, "0");
      if (ref.current) ref.current.textContent = `${min}:${sec}  ·  ${bar}.${beatInBar}`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [bpm, timeSig]);

  return (
    <span
      ref={ref}
      className="flex h-11 min-w-44 items-center justify-center rounded-full bg-muted px-5 text-[15px] font-medium whitespace-pre tabular-nums"
      aria-label="Posición"
    />
  );
}
