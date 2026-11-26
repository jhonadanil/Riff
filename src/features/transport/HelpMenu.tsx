import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { MenubarContent, MenubarItem, MenubarLabel, MenubarMenu, MenubarSeparator, MenubarTrigger } from "@/components/ui/menubar";
import { checkForUpdates } from "@/features/updates";

/** Menú «Ayuda» (solo en la app de escritorio): versión instalada, actualizaciones y registro. */
export function HelpMenu() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (isTauri()) void getVersion().then(setVersion);
  }, []);

  if (!isTauri()) return null;

  return (
    <MenubarMenu>
      <MenubarTrigger>Ayuda</MenubarTrigger>
      <MenubarContent className="min-w-60">
        <MenubarLabel className="text-xs font-normal text-muted-foreground">Riff Studio {version}</MenubarLabel>
        <MenubarSeparator />
        <MenubarItem onSelect={() => void checkForUpdates(true)}>
          <Download />
          Buscar actualizaciones
        </MenubarItem>
        <MenubarItem onSelect={() => void invoke("open_logs").catch((e) => toast.error(String(e)))}>
          <FileText />
          Mostrar archivo de registro
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
