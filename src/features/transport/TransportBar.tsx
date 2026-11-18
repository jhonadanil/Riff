import { useEffect, useRef, type ReactNode } from "react";
import { Circle, FileAudio, Magnet, Pause, Play, Redo2, Repeat, SkipBack, Timer, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";
import { importAudioFiles } from "@/features/tracks/importAudio";
import { togglePlay } from "@/features/shortcuts";
import { projectName } from "@/project/projectFile";
import { cn } from "@/lib/utils";
import { FileMenu } from "./FileMenu";

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
  const fileInput = useRef<HTMLInputElement>(null);

  const onImport = (files: FileList | null) => {
    if (!files?.length) return;
    const { selectedTrackId, tracks } = useProject.getState();
    const trackId = selectedTrackId ?? tracks[0]?.id;
    if (trackId) importAudioFiles(Array.from(files), trackId, engine.position());
  };

  return (
    <header className="flex h-14 items-center gap-3 border-b px-4">
      <span className="text-lg font-semibold tracking-tight">Riff</span>
      <FileMenu onImportAudio={() => fileInput.current?.click()} />
      <span className="max-w-48 truncate text-sm text-muted-foreground" title={s.projectPath ?? undefined}>
        {projectName(s.projectPath)}
        {s.dirty && <span aria-label="cambios sin guardar"> •</span>}
      </span>

      <Separator orientation="vertical" className="h-6!" />

      <div className="flex items-center gap-1">
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

      <Separator orientation="vertical" className="h-6!" />

      <div className="flex items-center gap-1">
        <Tip label="Volver al inicio (Inicio)">
          <Button variant="ghost" size="icon" onClick={() => engine.seek(0)} aria-label="Volver al inicio">
            <SkipBack />
          </Button>
        </Tip>
        <Tip label={`${s.isPlaying ? "Pausar" : "Reproducir"} (Espacio)`}>
          <Button
            variant={s.isPlaying ? "secondary" : "ghost"}
            size="icon"
            onClick={togglePlay}
            aria-label={s.isPlaying ? "Pausar" : "Reproducir"}
          >
            {s.isPlaying ? <Pause /> : <Play />}
          </Button>
        </Tip>
        <Tip label="Grabar (próximamente)">
          <Button variant="ghost" size="icon" onClick={s.toggleRecording} aria-label="Grabar">
            <Circle className={cn(s.isRecording && "fill-red-500 text-red-500")} />
          </Button>
        </Tip>
      </div>

      <TimeDisplay />

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        BPM
        <Input
          type="number"
          className="h-8 w-20 tabular-nums"
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

      <div className="flex items-center gap-1">
        <Tip label="Metrónomo (M)">
          <Toggle size="sm" pressed={s.metronome} onPressedChange={s.toggleMetronome} aria-label="Metrónomo">
            <Timer />
          </Toggle>
        </Tip>
        <Tip label={s.loop ? "Loop (L)" : "Loop (L) · arrastra en la regla para crear la región"}>
          <Toggle size="sm" pressed={s.loopEnabled} onPressedChange={s.toggleLoop} disabled={!s.loop} aria-label="Loop">
            <Repeat />
          </Toggle>
        </Tip>
        <Tip label="Ajustar a la rejilla (G)">
          <Toggle size="sm" pressed={s.snap} onPressedChange={s.toggleSnap} aria-label="Ajustar a la rejilla">
            <Magnet />
          </Toggle>
        </Tip>
      </div>

      <div className="ml-auto">
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
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
          <FileAudio />
          Importar audio
        </Button>
      </div>
    </header>
  );
}

/** Posición actual (min:seg y compás.tiempo), actualizada cada frame. */
function TimeDisplay() {
  const ref = useRef<HTMLSpanElement>(null);
  const bpm = useProject((s) => s.bpm);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
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
      className="min-w-36 rounded-md bg-muted px-2.5 py-1 font-mono text-sm whitespace-pre tabular-nums"
      aria-label="Posición"
    />
  );
}
