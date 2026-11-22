import { useEffect, useState } from "react";
import { Piano, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { midiEvents, reconnectMidi, refreshMidiPorts, useMidi } from "@/audio/midi";
import { cn } from "@/lib/utils";

/** Controladores MIDI (Maschine, teclado, pads) para tocar instrumentos VST3. */
export function MidiSection() {
  const { available, ports, enabled, status, errors, syncMs, setEnabled, setSyncMs } = useMidi();
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!available) return;
    void refreshMidiPorts();
  }, [available]);

  // Luz que parpadea al llegar mensajes: sirve para comprobar que el controlador está conectado
  useEffect(() => {
    if (status !== "on") return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout>;
    const id = setInterval(async () => {
      const n = await midiEvents().catch(() => last);
      if (n !== last) {
        last = n;
        setActive(true);
        clearTimeout(timer);
        timer = setTimeout(() => setActive(false), 150);
      }
    }, 80);
    return () => {
      clearInterval(id);
      clearTimeout(timer);
    };
  }, [status]);

  if (!available) return null;
  // Los activados que ya no están enchufados también se listan, para poder quitarlos
  const all = [...ports, ...enabled.filter((p) => !ports.includes(p))];

  return (
    <section className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <Piano className="size-4 shrink-0" />
        <div className="flex-1">
          <Label className="font-medium">Controladores MIDI</Label>
          <p className="text-xs text-muted-foreground">
            Activa los que vayas a usar. Cada pista elige de cuál toma las notas.
          </p>
        </div>
        <span
          className={cn("size-2.5 shrink-0 rounded-full transition-colors", active ? "bg-ok" : "bg-muted")}
          role="img"
          aria-label={active ? "Llega MIDI" : "Sin actividad MIDI"}
        />
        <Button size="icon-sm" variant="outline" onClick={() => void reconnectMidi()} aria-label="Buscar de nuevo">
          <RotateCw />
        </Button>
      </div>

      {all.length > 0 ? (
        <ul className="grid gap-1.5">
          {all.map((p) => {
            const here = ports.includes(p);
            return (
              <li key={p} className="flex items-center gap-3 rounded-md bg-muted/50 px-2.5 py-1.5">
                <span className={cn("min-w-0 flex-1 truncate text-sm", !here && "text-muted-foreground")}>
                  {p}
                  {!here && " (desconectado)"}
                </span>
                <Switch checked={enabled.includes(p)} onCheckedChange={(on) => setEnabled(p, on)} aria-label={`Usar ${p}`} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No se ve ningún dispositivo MIDI. Si es la Maschine MK3, pulsa Shift + Channel/MIDI para ponerla en modo MIDI.
        </p>
      )}

      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium select-none">Avanzado</summary>
        <div className="mt-3">
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <Label className="text-xs">Sincronía con las pistas</Label>
            <span className="text-muted-foreground tabular-nums">
              {syncMs > 0 ? "+" : ""}
              {syncMs} ms
            </span>
          </div>
          <Slider min={-150} max={300} step={1} value={[syncMs]} onValueChange={([v]) => setSyncMs(v)} aria-label="Sincronía MIDI (ms)" />
          <p className="text-xs text-muted-foreground">
            Al reproducir, si la batería suena <b>tarde</b> respecto a las demás pistas, sube este valor; si suena
            adelantada, bájalo.
          </p>
        </div>

        </div>
      </details>

      {status === "error" && (
        <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0 text-destructive" />
            No se pudo abrir:
          </div>
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {status === "on" ? "Conectado: toca un pad y la luz de arriba parpadea. " : ""}
        Si falla al conectar, cierra el software de Maschine o Komplete Kontrol: solo una aplicación puede usar el
        puerto a la vez.
      </p>
    </section>
  );
}
