import { AudioLines, Headphones, HeadphoneOff, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNative } from "@/audio/native";
import { recordingLatencyMs, retryInput, useInput, type InputChannel } from "@/audio/input";
import { cn } from "@/lib/utils";
import { InputMeter } from "./InputMeter";
import { MidiSection } from "./MidiSection";
import { NativeEngineSection } from "./NativeEngineSection";

const DEFAULT = "__default";

/** Botón de la barra de transporte: abre los ajustes de entrada y muestra su nivel mientras está abierta. */
export function InputButton() {
  const { status, panelOpen, monitored, monitorMuted, nativeMonitor, setPanelOpen, setMonitorMuted } = useInput();
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
            {(status === "open" || nativeMonitor) && <InputMeter className="w-16" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={monitorMuted ? "secondary" : "ghost"}
            className={cn("h-9 px-2.5", monitorMuted && "text-warn")}
            onClick={() => setMonitorMuted(!monitorMuted)}
            aria-label={monitorMuted ? "Monitor silenciado" : "Silenciar el monitor"}
            aria-pressed={monitorMuted}
          >
            {monitorMuted ? <HeadphoneOff /> : <Headphones />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {monitorMuted ? "Monitor silenciado: no te oyes al tocar" : "Silenciar el monitor (para que no se acople con micro y parlantes)"}
        </TooltipContent>
      </Tooltip>
      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <InputSettings />
      </Dialog>
    </>
  );
}

function InputSettings() {
  const native = useNative((s) => s.available);
  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Entrada de audio</DialogTitle>
        <DialogDescription>La interfaz y los controladores con los que vas a tocar y grabar.</DialogDescription>
      </DialogHeader>

      {native ? (
        <Tabs defaultValue="input" className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="input">Entrada</TabsTrigger>
            <TabsTrigger value="engine">Motor</TabsTrigger>
            <TabsTrigger value="midi">MIDI</TabsTrigger>
          </TabsList>
          <TabsContent value="input">
            <InputTab />
          </TabsContent>
          <TabsContent value="engine">
            <NativeEngineSection />
          </TabsContent>
          <TabsContent value="midi">
            <MidiSection />
          </TabsContent>
        </Tabs>
      ) : (
        <InputTab />
      )}
    </DialogContent>
  );
}

/** Canal por defecto y nivel de las entradas; lo del navegador (dispositivo, latencia) queda en «Avanzado». */
function InputTab() {
  const { devices, deviceId, channel, status, error, streamChannels, latency, nativeMonitor, setDevice, setChannel } = useInput();
  const mono = streamChannels < 2;
  const deviceLabel = devices.find((d) => d.id === deviceId)?.label ?? "el dispositivo predeterminado";

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="input-channel">Canal predeterminado</Label>
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
          Lo usan las pistas que no tienen entrada propia. Cada pista puede elegir la suya en su cabecera.
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
                    channel === "stereo" || channel === String(ch + 1) ? "font-medium" : "text-muted-foreground",
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
                : mono && !nativeMonitor
                  ? `Windows entrega ${deviceLabel} como mono (1 canal): la entrada 2 no llega por aquí. Mira «Avanzado».`
                  : "Ajusta la ganancia en la interfaz para que los golpes fuertes no lleguen al rojo."}
            </p>
          </>
        )}
      </div>

      <details className="group rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium select-none">Avanzado</summary>
        <div className="mt-3 grid gap-4">
          <p className="text-xs text-muted-foreground">
            Esto solo cuenta cuando el motor de baja latencia está apagado: entonces la entrada la abre el navegador.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="input-device">Dispositivo del navegador</Label>
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
            {status === "open" && mono && (
              <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
                Prueba a elegir la interfaz por su nombre en vez de «Predeterminado». Si sigue igual: Configuración de
                sonido de Windows › Más opciones de sonido › Grabar › tu interfaz › Propiedades › Opciones avanzadas, y
                elige un formato de <b>2 canales</b>.
              </p>
            )}
          </div>
          {latency && <LatencySection />}
        </div>
      </details>

      <p className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
        <Headphones className="mt-px size-3.5 shrink-0" />
        Para oírte al tocar, pulsa los auriculares de la pista (los instrumentos suenan con solo armarla). Usa
        auriculares si grabas con micro; los de la barra silencian el monitor.
      </p>
    </div>
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
