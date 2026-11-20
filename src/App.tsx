import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { TransportBar } from "@/features/transport/TransportBar";
import { TrackList } from "@/features/tracks/TrackList";
import { Mixer } from "@/features/mixer/Mixer";
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
            <Mixer />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
