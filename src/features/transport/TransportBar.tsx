import { useEffect, useRef } from "react";
import { Circle, FileAudio, Pause, Play, SkipBack } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";
import { importAudioFiles } from "@/features/tracks/importAudio";
import { cn } from "@/lib/utils";

export function TransportBar() {
  const { bpm, isPlaying, isRecording, setBpm, setPlaying, toggleRecording } = useProject();
  const fileInput = useRef<HTMLInputElement>(null);

  const togglePlay = async () => {
    if (isPlaying) engine.pause();
    else await engine.play();
    setPlaying(!isPlaying);
  };

  // Barra espaciadora = reproducir / pausar (salvo escribiendo en un campo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      document.getElementById("transport-play")?.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onImport = (files: FileList | null) => {
    if (!files?.length) return;
    const { selectedTrackId, tracks } = useProject.getState();
    const trackId = selectedTrackId ?? tracks[0]?.id;
    if (trackId) importAudioFiles(Array.from(files), trackId, engine.position());
  };

  return (
    <header className="flex h-14 items-center gap-4 border-b px-4">
      <span className="text-lg font-semibold tracking-tight">Riff</span>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => engine.seek(0)} aria-label="Volver al inicio">
              <SkipBack />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Volver al inicio</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              id="transport-play"
              variant={isPlaying ? "secondary" : "ghost"}
              size="icon"
              onClick={togglePlay}
              aria-label={isPlaying ? "Pausar" : "Reproducir"}
            >
              {isPlaying ? <Pause /> : <Play />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? "Pausar" : "Reproducir"} (Espacio)</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" onClick={toggleRecording} aria-label="Grabar">
          <Circle className={cn(isRecording && "fill-red-500 text-red-500")} />
        </Button>
      </div>

      <TimeDisplay />

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        BPM
        <Input
          type="number"
          className="h-8 w-20 tabular-nums"
          value={bpm}
          min={20}
          max={300}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 20 && v <= 300) setBpm(v);
          }}
        />
      </label>

      <div className="ml-auto">
        <input
          ref={fileInput}
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

/** Posición actual (min:seg.ms y compás.tiempo), actualizada cada frame. */
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
