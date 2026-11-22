import { useEffect, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { TransportBar } from "@/features/transport/TransportBar";
import { TrackList } from "@/features/tracks/TrackList";
import { Mixer } from "@/features/mixer/Mixer";
import { PianoRoll } from "@/features/pianoroll/PianoRoll";
import { useProject } from "@/store/project";
import { cn } from "@/lib/utils";
import { useShortcuts } from "@/features/shortcuts";
import { useAppWindow } from "@/features/useAppWindow";
import { useNativeTheme } from "@/features/theme/ThemeMenu";

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  useShortcuts();
  useAppWindow();
  useNativeTheme();

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TransportBar />
        <ResizablePanelGroup orientation="vertical" className="flex-1">
          <ResizablePanel defaultSize="65%" minSize="20%">
            <TrackList />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="35%" minSize="15%">
            <BottomPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

/** Zona inferior: el mezclador, o el piano roll cuando hay un clip MIDI abierto. */
function BottomPanel() {
  const editing = useProject((s) => s.editingClipId);
  const openPianoRoll = useProject((s) => s.openPianoRoll);
  const [tab, setTab] = useState<"mixer" | "roll">("mixer");

  // Al abrir un clip, mostrar el piano roll; al cerrarlo, volver al mezclador
  useEffect(() => setTab(editing ? "roll" : "mixer"), [editing]);

  const tabClass = (on: boolean) =>
    cn("px-3 py-1 text-xs font-medium transition-colors", on ? "text-foreground" : "text-muted-foreground hover:text-foreground");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2" role="tablist">
        <button role="tab" aria-selected={tab === "mixer"} className={tabClass(tab === "mixer")} onClick={() => setTab("mixer")}>
          Mezclador
        </button>
        <button
          role="tab"
          aria-selected={tab === "roll"}
          disabled={!editing}
          className={cn(tabClass(tab === "roll"), "disabled:opacity-40")}
          onClick={() => setTab("roll")}
          title={editing ? undefined : "Doble clic en un clip MIDI para editar sus notas"}
        >
          Piano roll
        </button>
        {editing && tab === "mixer" && (
          <button className="ml-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => openPianoRoll(null)}>
            cerrar piano roll
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{tab === "roll" && editing ? <PianoRoll /> : <Mixer />}</div>
    </div>
  );
}
