import { useEffect, useRef, useState } from "react";
import { RotateCw, TriangleAlert, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { nativeMeter, refreshNativeDevices, restartNative, useNative, type NativeMeter } from "@/audio/native";
import { cn } from "@/lib/utils";

const DRIVER_BUFFER = "driver";
const BUFFER_SIZES = [32, 64, 128, 256, 512, 1024];

/** Ajustes del motor nativo (ASIO/WASAPI): la vía de baja latencia para escucharse al tocar. */
export function NativeEngineSection() {
  const s = useNative();
  if (!s.available) return null;

  const inputs = s.devices.filter((d) => d.inputs > 0);
  const outputs = s.devices.filter((d) => d.outputs > 0);
  const asio = s.host === "ASIO";

  return (
    <section className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <Zap className="size-4 shrink-0" />
        <div className="flex-1">
          <Label htmlFor="native-on" className="font-medium">
            Motor de baja latencia <span className="font-normal text-muted-foreground">(beta)</span>
          </Label>
          <p className="text-xs text-muted-foreground">Escúchate al tocar en tiempo real, por ASIO.</p>
        </div>
        <Switch id="native-on" checked={s.enabled} onCheckedChange={s.setEnabled} />
      </div>

      {s.enabled && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">Sistema</Label>
              <Select value={s.host ?? ""} onValueChange={s.setHost}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {s.hosts.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Búfer</Label>
              <Select
                value={s.bufferSize === null ? DRIVER_BUFFER : String(s.bufferSize)}
                onValueChange={(v) => s.setBufferSize(v === DRIVER_BUFFER ? null : Number(v))}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DRIVER_BUFFER}>El del driver</SelectItem>
                  {BUFFER_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} muestras
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className={cn("grid gap-2", !asio && "grid-cols-2")}>
            <div className="grid gap-1.5">
              <Label className="text-xs">{asio ? "Driver ASIO" : "Entrada"}</Label>
              <Select value={s.inputId ?? ""} onValueChange={(v) => (asio ? (s.setInput(v), s.setOutput(v)) : s.setInput(v))}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="Elige…" />
                </SelectTrigger>
                <SelectContent>
                  {inputs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!asio && (
              <div className="grid gap-1.5">
                <Label className="text-xs">Salida</Label>
                <Select value={s.outputId ?? ""} onValueChange={s.setOutput}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder="Elige…" />
                  </SelectTrigger>
                  <SelectContent>
                    {outputs.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {s.status === "error" ? (
            <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
              <p className="flex-1">{s.error}</p>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void refreshNativeDevices();
                  restartNative();
                }}
              >
                <RotateCw />
                Reintentar
              </Button>
            </div>
          ) : s.status === "on" ? (
            <NativeStatus />
          ) : (
            <p className="text-xs text-muted-foreground">{s.status === "starting" ? "Arrancando el motor…" : "Parado."}</p>
          )}

          <p className="text-xs text-muted-foreground">
            {asio
              ? "Con ASIO el tamaño de búfer suele mandarlo el panel del driver: cuanto más pequeño, menos retraso (64–128 va bien)."
              : "Sin ASIO la latencia es mayor. Instala el driver ASIO de tu interfaz (en una Scarlett: Focusrite Control) para bajarla."}{" "}
            Al pulsar los auriculares de una pista te oirás por aquí.
          </p>
        </>
      )}
    </section>
  );
}

/** Latencia medida, cortes y nivel de las dos entradas, leído del motor nativo. */
function NativeStatus() {
  const info = useNative((s) => s.info);
  const [meter, setMeter] = useState<NativeMeter | null>(null);
  const bars = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    let last = 0;
    const id = setInterval(async () => {
      const m = await nativeMeter().catch(() => null);
      if (!alive || !m) return;
      m.peaks.forEach((p, i) => {
        const el = bars.current[i];
        if (el) el.style.width = `${Math.min(100, Math.sqrt(p) * 100)}%`;
      });
      // Los números se refrescan más despacio para que se puedan leer
      if (Date.now() - last > 500) {
        last = Date.now();
        setMeter(m);
      }
    }, 50);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!info) return null;
  const bufferMs = info.bufferSize ? (info.bufferSize / info.sampleRate) * 1000 : null;
  const measured = meter ? meter.inputLatencyMs + meter.outputLatencyMs : null;
  const total = measured && measured > 0 ? measured : bufferMs !== null ? bufferMs * 2 : null;

  return (
    <div className="grid gap-2 text-xs">
      {[0, 1].map((ch) => (
        <div key={ch} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-muted-foreground">Entrada {ch + 1}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div ref={(el) => void (bars.current[ch] = el)} className="h-full w-0 rounded-full bg-foreground/70" />
          </div>
        </div>
      ))}
      <p className="text-muted-foreground tabular-nums">
        {info.outputName} · {(info.sampleRate / 1000).toFixed(1)} kHz
        {info.bufferSize ? ` · ${info.bufferSize} muestras` : ""}
        {total !== null && (
          <>
            {" · "}
            <span className="font-medium text-foreground">~{total.toFixed(1)} ms</span> de retraso
          </>
        )}
        {meter && meter.xruns > 0 && ` · ${meter.xruns} cortes`}
      </p>
    </div>
  );
}
