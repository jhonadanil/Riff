import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { TransportBar } from "@/features/transport/TransportBar";
import { TrackList } from "@/features/tracks/TrackList";
import { Mixer } from "@/features/mixer/Mixer";
import { useShortcuts } from "@/features/shortcuts";

export default function App() {
  useShortcuts();

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
            <Mixer />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
