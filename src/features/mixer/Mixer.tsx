import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useProject } from "@/store/project";
import { cn } from "@/lib/utils";

const panLabel = (p: number) => (Math.abs(p) < 0.01 ? "C" : `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`);

export function Mixer() {
  const { tracks, updateTrack } = useProject();

  return (
    <div className="flex h-full overflow-x-auto bg-background">
      {tracks.map((t) => (
        <div key={t.id} className="flex h-full w-24 shrink-0 flex-col items-center gap-2 border-r pt-4 pb-3">
          <div className="flex w-full flex-col items-center gap-1 px-3">
            <Slider
              min={-1}
              max={1}
              step={0.01}
              value={[t.pan]}
              onValueChange={([v]) => updateTrack(t.id, { pan: v })}
              onDoubleClick={() => updateTrack(t.id, { pan: 0 })}
              aria-label={`Panorama ${t.name}`}
            />
            <span className="text-[10px] tabular-nums text-muted-foreground">{panLabel(t.pan)}</span>
          </div>
          <div className="flex gap-1">
            <Button
              size="icon-xs"
              variant={t.muted ? "secondary" : "ghost"}
              className={cn(t.muted && "text-warn")}
              onClick={() => updateTrack(t.id, { muted: !t.muted })}
              aria-label={`Mute ${t.name}`}
              aria-pressed={t.muted}
            >
              M
            </Button>
            <Button
              size="icon-xs"
              variant={t.soloed ? "secondary" : "ghost"}
              className={cn(t.soloed && "text-solo")}
              onClick={() => updateTrack(t.id, { soloed: !t.soloed })}
              aria-label={`Solo ${t.name}`}
              aria-pressed={t.soloed}
            >
              S
            </Button>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(t.volume * 100)}</span>
          <Slider
            orientation="vertical"
            className="min-h-0 flex-1 data-vertical:min-h-16"
            min={0}
            max={1}
            step={0.01}
            value={[t.volume]}
            onValueChange={([v]) => updateTrack(t.id, { volume: v })}
            aria-label={`Volumen ${t.name}`}
          />
          <span className="w-full truncate px-2 text-center text-xs font-medium" style={{ color: t.color }}>
            {t.name}
          </span>
        </div>
      ))}
    </div>
  );
}
