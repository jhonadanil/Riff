import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useProject, type Bus, type Track } from "@/store/project";
import { trackAutomation } from "@/audio/mix";
import { cn } from "@/lib/utils";
import { LevelMeter } from "./LevelMeter";

const panLabel = (p: number) => (Math.abs(p) < 0.01 ? "C" : `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`);
const dbLabel = (v: number) => (v <= 0.0001 ? "−∞" : `${(20 * Math.log10(v)).toFixed(1).replace("-", "−")}`);

/** Mezclador: una tira por pista, los buses y el master. */
export function Mixer() {
  const { tracks, buses, master, updateTrack, updateBus, setMaster, addBus, removeBus } = useProject();

  return (
    <div className="flex h-full overflow-x-auto bg-background">
      {tracks.map((t) => (
        <Strip
          key={t.id}
          id={t.id}
          name={t.name}
          color={t.color}
          volume={t.volume}
          pan={t.pan}
          muted={t.muted}
          soloed={t.soloed}
          badge={trackAutomation(t) ? "A" : undefined}
          onChange={(patch) => updateTrack(t.id, patch)}
          extra={<Routing track={t} buses={buses} />}
        />
      ))}

      <div className="mx-1 w-px shrink-0 bg-border" />

      {buses.map((b) => (
        <Strip
          key={b.id}
          id={b.id}
          name={b.name}
          color={b.color}
          volume={b.volume}
          pan={b.pan}
          muted={b.muted}
          soloed={b.soloed}
          onChange={(patch) => updateBus(b.id, patch)}
          onRename={(name) => updateBus(b.id, { name })}
          onRemove={() => removeBus(b.id)}
        />
      ))}
      <div className="flex w-20 shrink-0 items-start justify-center pt-4">
        <Button variant="ghost" size="sm" onClick={addBus} title="Añadir un bus (grupo o retorno de efectos)">
          <Plus />
          Bus
        </Button>
      </div>

      <div className="ml-auto flex shrink-0">
        <Strip id="master" name="Master" color="var(--foreground)" volume={master} max={1.5} onVolume={setMaster} />
      </div>
    </div>
  );
}

type StripProps = {
  id: string;
  name: string;
  color: string;
  volume: number;
  /** Máximo del fader (1 = 0 dB). */
  max?: number;
  pan?: number;
  muted?: boolean;
  soloed?: boolean;
  badge?: string;
  extra?: React.ReactNode;
  onChange?: (patch: Partial<Track & Bus>) => void;
  onVolume?: (v: number) => void;
  onRename?: (name: string) => void;
  onRemove?: () => void;
};

function Strip({ id, name, color, volume, max = 1, pan, muted, soloed, badge, extra, onChange, onVolume, onRename, onRemove }: StripProps) {
  const [editing, setEditing] = useState(false);
  const setVolume = (v: number) => (onVolume ? onVolume(v) : onChange?.({ volume: v }));

  return (
    <div className="flex h-full w-28 shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r px-2 pt-3 pb-2">
      {extra}
      {pan !== undefined && (
        <div className="flex w-full flex-col items-center gap-0.5 px-1">
          <Slider
            min={-1}
            max={1}
            step={0.01}
            value={[pan]}
            onValueChange={([v]) => onChange?.({ pan: v })}
            onDoubleClick={() => onChange?.({ pan: 0 })}
            aria-label={`Panorama ${name}`}
          />
          <span className="text-[10px] tabular-nums text-muted-foreground">{panLabel(pan)}</span>
        </div>
      )}
      {muted !== undefined && soloed !== undefined && (
        <div className="flex gap-1">
          <Button
            size="icon-xs"
            variant={muted ? "secondary" : "ghost"}
            className={cn(muted && "text-warn")}
            onClick={() => onChange?.({ muted: !muted })}
            aria-label={`Mute ${name}`}
            aria-pressed={muted}
          >
            M
          </Button>
          <Button
            size="icon-xs"
            variant={soloed ? "secondary" : "ghost"}
            className={cn(soloed && "text-solo")}
            onClick={() => onChange?.({ soloed: !soloed })}
            aria-label={`Solo ${name}`}
            aria-pressed={soloed}
          >
            S
          </Button>
        </div>
      )}
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {dbLabel(volume)} dB{badge && <span className="ml-1 rounded-sm bg-muted px-1 text-foreground" title="Tiene automatización">{badge}</span>}
      </span>
      <div className="flex min-h-16 flex-1 items-stretch gap-2">
        <Slider
          orientation="vertical"
          className="min-h-0 flex-1 data-vertical:min-h-16"
          min={0}
          max={max}
          step={0.01}
          value={[volume]}
          onValueChange={([v]) => setVolume(v)}
          onDoubleClick={() => setVolume(id === "master" ? 1 : 0.8)}
          aria-label={`Volumen ${name}`}
        />
        <LevelMeter id={id} label={name} />
      </div>
      <div className="flex w-full items-center justify-center gap-0.5">
        {editing && onRename ? (
          <input
            autoFocus
            defaultValue={name}
            className="min-w-0 flex-1 rounded-sm border bg-background px-1 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
            aria-label="Nombre del bus"
            onBlur={(e) => {
              setEditing(false);
              const v = e.target.value.trim();
              if (v && v !== name) onRename(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-center text-xs font-medium"
            style={{ color }}
            title={onRename ? "Doble clic para renombrar" : name}
            onDoubleClick={() => onRename && setEditing(true)}
          >
            {name}
          </span>
        )}
        {onRemove && (
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={`Quitar ${name}`} title="Quitar el bus">
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Salida de una pista (master o un bus) y sus envíos a los buses. */
function Routing({ track, buses }: { track: Track; buses: Bus[] }) {
  const updateTrack = useProject((s) => s.updateTrack);
  if (!buses.length) return null;
  return (
    <div className="flex w-full flex-col gap-1">
      <select
        className="h-6 w-full rounded-sm border bg-background px-1 text-[11px] outline-none focus:ring-2 focus:ring-ring"
        value={track.out ?? ""}
        onChange={(e) => updateTrack(track.id, { out: e.target.value || undefined })}
        aria-label={`Salida de ${track.name}`}
        title="A dónde va la pista"
      >
        <option value="">→ Master</option>
        {buses.map((b) => (
          <option key={b.id} value={b.id}>
            → {b.name}
          </option>
        ))}
      </select>
      {buses.map((b) => (
        <label key={b.id} className="flex items-center gap-1 text-[10px] text-muted-foreground" title={`Envío a ${b.name}`}>
          <span className="w-8 shrink-0 truncate">{b.name}</span>
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[track.sends?.[b.id] ?? 0]}
            onValueChange={([v]) => updateTrack(track.id, { sends: { ...track.sends, [b.id]: v } })}
            onDoubleClick={() => updateTrack(track.id, { sends: { ...track.sends, [b.id]: 0 } })}
            aria-label={`Envío de ${track.name} a ${b.name}`}
          />
        </label>
      ))}
    </div>
  );
}
