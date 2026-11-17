import { Circle, Play, SkipBack, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProject } from "@/store/project";
import * as engine from "@/audio/engine";
import { cn } from "@/lib/utils";

export function TransportBar() {
  const { bpm, isPlaying, isRecording, setBpm, setPlaying, toggleRecording } = useProject();

  const togglePlay = async () => {
    if (isPlaying) engine.stop();
    else await engine.play(bpm);
    setPlaying(!isPlaying);
  };

  return (
    <header className="flex h-14 items-center gap-4 border-b px-4">
      <span className="text-lg font-semibold tracking-tight">Riff</span>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Volver al inicio">
              <SkipBack />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Volver al inicio</TooltipContent>
        </Tooltip>
        <Button
          variant={isPlaying ? "secondary" : "ghost"}
          size="icon"
          onClick={togglePlay}
          aria-label={isPlaying ? "Parar" : "Reproducir"}
        >
          {isPlaying ? <Square /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon" onClick={toggleRecording} aria-label="Grabar">
          <Circle className={cn(isRecording && "fill-red-500 text-red-500")} />
        </Button>
      </div>

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
            setBpm(v);
            engine.setBpm(v);
          }}
        />
      </label>
    </header>
  );
}
