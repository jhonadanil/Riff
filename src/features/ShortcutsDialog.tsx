import { useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Lista de atajos que se muestra en el diálogo (mantener al día con useShortcuts). */
const GROUPS: { title: string; items: [keys: string[], label: string][] }[] = [
  {
    title: "Transporte",
    items: [
      [["Espacio"], "Reproducir / pausar"],
      [["R"], "Grabar / parar la grabación"],
      [["C"], "Cuenta previa antes de grabar"],
      [["Inicio"], "Volver al inicio"],
      [["M"], "Metrónomo"],
      [["L"], "Activar / desactivar loop"],
    ],
  },
  {
    title: "Edición",
    items: [
      [["S"], "Dividir el clip en el cursor"],
      [["Supr"], "Borrar los clips seleccionados"],
      [["Esc"], "Quitar la selección (o cerrar el piano roll)"],
      [["Ctrl", "C"], "Copiar los clips seleccionados"],
      [["Ctrl", "V"], "Pegar en el cursor, en la pista seleccionada"],
      [["Ctrl", "D"], "Duplicar justo a continuación"],
      [["Ctrl", "A"], "Seleccionar todos los clips"],
      [["G"], "Ajustar a la rejilla"],
      [["Ctrl", "Z"], "Deshacer"],
      [["Ctrl", "Y"], "Rehacer"],
    ],
  },
  {
    title: "Proyecto",
    items: [
      [["Ctrl", "N"], "Nuevo proyecto"],
      [["Ctrl", "O"], "Abrir proyecto"],
      [["Ctrl", "S"], "Guardar"],
      [["Ctrl", "Shift", "S"], "Guardar como"],
      [["Ctrl", "I"], "Importar audio"],
      [["Ctrl", "E"], "Exportar a WAV"],
    ],
  },
  {
    title: "Ratón",
    items: [
      [["Ctrl", "Rueda"], "Zoom horizontal"],
      [["Arrastrar en la regla"], "Crear región de loop"],
      [["Doble clic en el loop"], "Quitar loop"],
      [["Mayús", "clic"], "Añadir un clip a la selección"],
      [["Doble clic en un clip MIDI"], "Abrir el piano roll"],
    ],
  },
  {
    title: "Ayuda",
    items: [[["?"], "Ver esta lista"]],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted px-1.5 font-sans text-xs font-medium text-foreground">
      {children}
    </kbd>
  );
}

/** Lista de atajos. La abre el menú de ajustes (o la tecla «?», ver `useShortcutsKey`). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Atajos de teclado</DialogTitle>
            <DialogDescription>Funcionan siempre que no estés escribiendo en un campo de texto.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {GROUPS.map((g) => (
              <section key={g.title}>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">{g.title}</h3>
                <ul className="space-y-1.5">
                  {g.items.map(([keys, label]) => (
                    <li key={label} className="flex items-center justify-between gap-4 text-sm">
                      <span>{label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** La tecla «?» abre y cierra la lista de atajos. */
export function useShortcutsKey(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}
