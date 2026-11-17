import { Button } from "@/components/ui/button";
import { useProject } from "@/store/project";
import { cn } from "@/lib/utils";

export function TrackList() {
  const { tracks, updateTrack } = useProject();

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {tracks.map((t) => (
        <div key={t.id} className="flex h-20 shrink-0 border-b">
          <div className="flex w-56 shrink-0 items-center gap-1 border-r px-3">
            <span className="mr-1 h-10 w-1 rounded-full" style={{ background: t.color }} />
            <span className="flex-1 truncate text-sm font-medium">{t.name}</span>
            <Button
              size="icon-sm"
              variant={t.muted ? "secondary" : "ghost"}
              onClick={() => updateTrack(t.id, { muted: !t.muted })}
              aria-label="Mute"
            >
              M
            </Button>
            <Button
              size="icon-sm"
              variant={t.soloed ? "secondary" : "ghost"}
              onClick={() => updateTrack(t.id, { soloed: !t.soloed })}
              aria-label="Solo"
            >
              S
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn(t.armed && "text-red-500")}
              onClick={() => updateTrack(t.id, { armed: !t.armed })}
              aria-label="Armar grabación"
            >
              R
            </Button>
          </div>
          {/* Aquí irá la línea de tiempo con clips y formas de onda (wavesurfer.js) */}
          <div className="relative flex-1 bg-muted/20" />
        </div>
      ))}
    </div>
  );
}
