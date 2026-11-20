import { useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCw, TriangleAlert, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { nativeMeter, restartNative, useNative, type NativeDevice, type NativeHost, type NativeMeter } from "@/audio/native";

const DRIVER_BUFFER = "driver";
const BUFFER_SIZES = [32, 64, 128, 256, 512, 1024];

/** Ajustes del motor nativo (ASIO/WASAPI): la vía de baja latencia para escucharse al tocar. */
export function NativeEngineSection() {
  const s = useNative();
  if (!s.available) return null;

  const asio = s.host === "ASIO";
  const outHost = s.outputHost ?? s.host;
  // ASIO a los dos lados: un driver ASIO solo se abre una vez, así que la salida es el mismo
  const sameAsio = asio && outHost === "ASIO";
  const split = outHost !== s.host;
  // En ASIO se listan todos los drivers (aunque no informen de canales: el error real sale al arrancar)
  const inputs = asio ? s.devices : s.devices.filter((d) => d.inputs > 0);
  const outputs = outHost === "ASIO" ? s.outputDevices : s.outputDevices.filter((d) => d.outputs > 0);

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
          <div className="grid gap-3">
            <Field label="Entrada">
              <HostSelect value={s.host} hosts={s.hosts} onChange={s.setHost} />
              <DeviceSelect
                value={s.inputId}
                devices={inputs}
                onChange={(v) => (sameAsio ? (s.setInput(v), s.setOutput(v)) : s.setInput(v))}
              />
            </Field>

            <Field label="Salida">
              <HostSelect value={outHost} hosts={s.hosts} onChange={s.setOutputHost} />
              {sameAsio ? (
                <p className="text-xs text-muted-foreground">El mismo driver ASIO de la entrada.</p>
              ) : (
                <DeviceSelect value={s.outputId} devices={outputs} onChange={s.setOutput} />
              )}
            </Field>

            <Field label="Búfer">
              <Select
                value={s.bufferSize === null ? DRIVER_BUFFER : String(s.bufferSize)}
                onValueChange={(v) => s.setBufferSize(v === DRIVER_BUFFER ? null : Number(v))}
              >
                <SelectTrigger size="sm" className="w-full min-w-0">
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
            </Field>
          </div>

          {s.status === "error" ? (
            <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
              <p className="flex-1">{s.error}</p>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void restartNative()}
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
            {split && "Con entrada y salida en sistemas distintos (p. ej. interfaz por ASIO y parlantes de la PC por WASAPI) se añade algo de retraso. "}
            Al pulsar los auriculares de una pista te oirás por aquí.
          </p>
        </>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
      <Label className="h-7 text-xs text-muted-foreground">{label}</Label>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  );
}

function HostSelect({ value, hosts, onChange }: { value: string | null; hosts: NativeHost[]; onChange: (v: string) => void }) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full min-w-0">
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {hosts.map((h) => (
          <SelectItem key={h.id} value={h.id}>
            {h.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DeviceSelect({ value, devices, onChange }: { value: string | null; devices: NativeDevice[]; onChange: (v: string) => void }) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full min-w-0">
        <SelectValue placeholder="Elige…" />
      </SelectTrigger>
      <SelectContent>
        {devices.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Latencia medida, cortes y nivel de las dos entradas, leído del motor nativo. */
function NativeStatus() {
  const info = useNative((s) => s.info);
  const [meter, setMeter] = useState<NativeMeter | null>(null);
  const [silent, setSilent] = useState(false);
  const bars = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    let last = 0;
    let zeroSince = 0;
    const id = setInterval(async () => {
      const m = await nativeMeter().catch(() => null);
      if (!alive || !m) return;
      m.peaks.forEach((p, i) => {
        const el = bars.current[i];
        if (el) el.style.width = `${Math.min(100, Math.sqrt(p) * 100)}%`;
      });
      // Una interfaz conectada siempre deja un poco de ruido: ceros exactos durante 3 s
      // significan que el driver no está conectado a ninguna entrada real.
      if (m.peaks[0] === 0 && m.peaks[1] === 0) {
        zeroSince ||= Date.now();
        setSilent(Date.now() - zeroSince > 3000);
      } else {
        zeroSince = 0;
        setSilent(false);
      }
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
      {silent && (
        <div className="flex items-start gap-3 rounded-md border border-warn/40 bg-warn/5 p-3">
          <TriangleAlert className="mt-px size-4 shrink-0 text-warn" />
          <p>
            La entrada llega en <b>silencio absoluto</b>: el driver está abierto pero no está conectado a tu interfaz. Con
            ASIO4ALL, abre su panel (icono de la bandeja) y activa tu interfaz; o instala el driver ASIO del fabricante.
          </p>
        </div>
      )}
      {[0, 1].map((ch) => (
        <div key={ch} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-muted-foreground">Entrada {ch + 1}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div ref={(el) => void (bars.current[ch] = el)} className="h-full w-0 rounded-full bg-foreground/70" />
          </div>
        </div>
      ))}
      <p className="text-muted-foreground tabular-nums">
        {info.outputName}{info.outputHost !== info.host ? ` (${info.outputHost})` : ""} · {(info.sampleRate / 1000).toFixed(1)} kHz
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
