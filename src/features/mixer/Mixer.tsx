import { Slider } from "@/components/ui/slider";
import { useProject } from "@/store/project";

export function Mixer() {
  const { tracks, updateTrack } = useProject();

  return (
    <div className="flex h-full gap-px overflow-x-auto bg-border">
      {tracks.map((t) => (
        <div key={t.id} className="flex w-24 shrink-0 flex-col items-center gap-3 bg-background py-3">
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(t.volume * 100)}</span>
          <Slider
            orientation="vertical"
            className="flex-1"
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
