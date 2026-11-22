import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Keyboard, Monitor, Moon, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShortcutsDialog, useShortcutsKey } from "@/features/ShortcutsDialog";

const OPTIONS = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Oscuro", icon: Moon },
  { value: "system", label: "Como el sistema", icon: Monitor },
] as const;

/** Ajustes y ayuda: tema de la app y lista de atajos de teclado. */
export function SettingsMenu() {
  const { theme = "system", setTheme } = useTheme();
  const [shortcuts, setShortcuts] = useState(false);
  useShortcutsKey(useCallback(() => setShortcuts((o) => !o), []));

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Ajustes y ayuda" title="Tema y atajos de teclado">
            <Settings />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel>Tema</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            {OPTIONS.map(({ value, label, icon: ItemIcon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <ItemIcon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShortcuts(true)}>
            <Keyboard />
            Atajos de teclado
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </>
  );
}

/** La barra de título nativa de la ventana sigue el tema de la app. */
export function useNativeTheme() {
  const { theme } = useTheme();
  useEffect(() => {
    if (!isTauri()) return;
    // null = que Windows decida (modo "Como el sistema")
    const native = theme === "light" || theme === "dark" ? theme : null;
    getCurrentWindow().setTheme(native).catch(console.error);
  }, [theme]);
}
