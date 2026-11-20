import { AudioLines, Headphones, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { recordingLatencyMs, retryInput, useInput, type InputChannel } from "@/audio/input";
import { cn } from "@/lib/utils";
import { InputMeter } from "./InputMeter";
import { NativeEngineSection } from "./NativeEngineSection";

const DEFAULT = "__default";

/** Botón de la barra de transporte: abre los ajustes de entrada y muestra su nivel mientras está abierta. */
export function InputButton() {
  const { status, panelOpen, monitored, setPanelOpen } = useInput();
  const label =
    status === "error" ? "Entrada de audio: error" : monitored.length ? "Entrada de audio · monitorizando" : "Entrada de audio";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className={cn("h-9 gap-2 px-3", status === "error" && "text-destructive")}
            onClick={() => setPanelOpen(true)}
            aria-label={label}
          >
            {status === "error" ? <TriangleAlert /> : monitored.length ? <Headphones /> : <AudioLines />}
            {status === "open" && <InputMeter className="w-16" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <InputSettings />
      </Dialog>
    </>
  );
}

function InputSettings() {
  const { devices, deviceId, channel, status, error, streamChannels, latency, setDevice, setChannel } = useInput();
  const mono = streamChannels < 2;
  const deviceLabel = devices.find((d) => d.id === deviceId)?.label ?? "el dispositivo predeterminado";

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Entrada de audio</DialogTitle>
        <DialogDescription>La interfaz o el micro con el que vas a grabar.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="input-device">Dispositivo</Label>
          <Select value={deviceId ?? DEFAULT} onValueChange={(v) => setDevice(v === DEFAULT ? null : v)}>
            <SelectTrigger id="input-device" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>Predeterminado del sistema</SelectItem>
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="input-channel">Canal</Label>
          <Select value={channel} onValueChange={(v) => setChannel(v as InputChannel)}>
            <SelectTrigger id="input-channel" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Entrada 1 (mono)</SelectItem>
              <SelectItem value="2">Entrada 2 (mono)</SelectItem>
              <SelectItem value="stereo">Entradas 1 + 2 (estéreo)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Guitarra, bajo o voz van en mono: elige la entrada donde está enchufado. Toca y mira abajo por cuál llega la
            señal.
          </p>
        </div>

        <div className="grid gap-2">
          <Label>Nivel</Label>
          {status === "error" ? (
            <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="flex-1">{error}</p>
              <Button size="xs" variant="outline" onClick={retryInput}>
                <RotateCw />
                Reintentar
              </Button>
            </div>
          ) : (
            <>
              {([0, 1] as const).map((ch) => (
                <div key={ch} className="flex items-center gap-3">
                  <span
                    className={cn(
                      "w-16 shrink-0 text-xs",
                      (channel === "stereo" || channel === String(ch + 1)) ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    Entrada {ch + 1}
                  </span>
                  <InputMeter channel={ch} className="flex-1" showScale={ch === 1} />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {status === "opening"
                  ? "Abriendo la entrada…"
                  : mono
                    ? `Windows entrega ${deviceLabel} como mono (1 canal): la entrada 2 no llega por aquí. Mira abajo cómo arreglarlo.`
                    : "Ajusta la ganancia en la interfaz para que los golpes fuertes no lleguen al rojo."}
              </p>
              {status === "open" && mono && (
                <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
                  Prueba a elegir arriba la interfaz por su nombre en vez de «Predeterminado». Si sigue igual: Configuración
                  de sonido de Windows › Más opciones de sonido › Grabar › tu interfaz › Propiedades › Opciones avanzadas,
                  y elige un formato de <b>2 canales</b>. Algunas interfaces muestran cada entrada como un dispositivo
                  aparte: en ese caso aparecerá en la lista de dispositivos.
                </p>
              )}
            </>
          )}
        </div>

        {latency && <LatencySection />}

        <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          <Headphones className="mt-px size-3.5 shrink-0" />
          Para escucharte mientras tocas, pulsa el botón de auriculares en la pista. Usa auriculares si grabas con micro:
          con altavoces se acopla.
        </p>

        <NativeEngineSection />
      </div>
    </DialogContent>
  );
}

/** Latencia medida y compensación de las tomas (automática + ajuste fino). */
function LatencySection() {
  const { latency, latencyOffsetMs, setLatencyOffset } = useInput();
  const { auto, total } = recordingLatencyMs();
  if (!latency) return null;
  const roundTrip = Math.round((latency.input ?? latency.output) + latency.output);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">Compensación al grabar</span>
        <span className="text-muted-foreground tabular-nums">
          {Math.round(total)} ms
          {latencyOffsetMs !== 0 && ` (auto ${Math.round(auto)} ${latencyOffsetMs > 0 ? "+" : "−"} ${Math.abs(latencyOffsetMs)})`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-14 shrink-0 text-xs text-muted-foreground">Ajuste</span>
        <Slider
          min={-100}
          max={200}
          step={1}
          value={[latencyOffsetMs]}
          onValueChange={([v]) => setLatencyOffset(v)}
          aria-label="Ajuste fino de la compensación (ms)"
          className="flex-1"
        />
        <Button variant="ghost" size="xs" onClick={() => setLatencyOffset(0)} disabled={latencyOffsetMs === 0}>
          0
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Las tomas se adelantan solas para cuadrar con el metrónomo. Si aun así quedan retrasadas, sube el ajuste; si quedan
        adelantadas, bájalo. Al tocar te oyes con unos {roundTrip} ms de retraso
        {latency.input === null && " (estimado)"}.
      </p>
    </div>
  );
}
