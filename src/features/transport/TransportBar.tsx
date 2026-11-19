import { useEffect, useRef, type ReactNode } from "react";
import { Circle, FileAudio, Hourglass, Magnet, Pause, Play, Redo2, Repeat, SkipBack, Timer, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";
import { importAudioFiles } from "@/features/tracks/importAudio";
import { togglePlay } from "@/features/shortcuts";
import { countInRemaining, toggleRecord, useRecorder } from "@/audio/recorder";
import { projectName } from "@/project/projectFile";
import { cn } from "@/lib/utils";
import { FileMenu } from "./FileMenu";
import { InputButton } from "@/features/input/InputDialog";
import { ThemeMenu } from "@/features/theme/ThemeMenu";
import { ShortcutsButton } from "@/features/ShortcutsDialog";

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

  const onImport = (files: FileList | null) => {
    if (!files?.length) return;
    const { selectedTrackId, tracks } = useProject.getState();
    const trackId = selectedTrackId ?? tracks[0]?.id;
    if (trackId) importAudioFiles(Array.from(files), trackId, engine.position());
  };

  return (
    <header className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b px-4">
      {/* Izquierda: proyecto */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="pr-1 pl-1 text-[17px] font-semibold tracking-[-0.02em]">Riff</span>
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
              className={cn("hover:bg-raised", recording && "bg-red-500/15 hover:bg-red-500/25")}
              onClick={() => void toggleRecord()}
              aria-label={recording ? "Parar la grabación" : "Grabar"}
              aria-pressed={recording}
            >
              <Circle
                className={cn(
                  "size-3.5 fill-current text-red-500",
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
          <Tip label="Metrónomo (M)">
            <Toggle className={pillToggle} pressed={s.metronome} onPressedChange={s.toggleMetronome} aria-label="Metrónomo">
              <Timer />
            </Toggle>
          </Tip>
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
        <ShortcutsButton />
        <ThemeMenu />

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
        <Button variant="outline" onClick={() => fileInput.current?.click()} className="h-9 px-4">
          <FileAudio />
          Importar audio
        </Button>
      </div>
    </header>
  );
}

/** Conmutador dentro de un grupo gris: el activo se "levanta" en blanco (o gris claro en oscuro). */
const pillToggle =
  "size-9 rounded-full text-muted-foreground hover:bg-raised/70 hover:text-foreground data-[state=on]:bg-raised data-[state=on]:text-foreground data-[state=on]:shadow-raised aria-pressed:bg-raised";

/** Posición actual (min:seg y compás.tiempo), actualizada cada frame. */
function TimeDisplay() {
  const ref = useRef<HTMLSpanElement>(null);
  const bpm = useProject((s) => s.bpm);

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
      const beat = (s * bpm) / 60;
      const bar = Math.floor(beat / 4) + 1;
      const beatInBar = Math.floor(beat % 4) + 1;
      const min = Math.floor(s / 60);
      const sec = (s % 60).toFixed(1).padStart(4, "0");
      if (ref.current) ref.current.textContent = `${min}:${sec}  ·  ${bar}.${beatInBar}`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [bpm]);

  return (
    <span
      ref={ref}
      className="flex h-11 min-w-44 items-center justify-center rounded-full bg-muted px-5 text-[15px] font-medium whitespace-pre tabular-nums"
      aria-label="Posición"
    />
  );
}
