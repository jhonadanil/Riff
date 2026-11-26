import { FileAudio, FilePlus, FolderOpen, Save } from "lucide-react";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { exportWav, newProject, openProject, saveProject, saveProjectAs } from "@/project/projectFile";
import { clearRecent, useRecentProjects } from "@/project/recent";
import { HelpMenu } from "./HelpMenu";

export function FileMenu({ onImportAudio }: { onImportAudio: () => void }) {
  const recent = useRecentProjects();

  return (
    <Menubar className="border-none bg-transparent p-0 shadow-none">
      <MenubarMenu>
        <MenubarTrigger>Archivo</MenubarTrigger>
        <MenubarContent className="min-w-64">
          <MenubarItem onSelect={newProject}>
            <FilePlus />
            Nuevo proyecto
            <MenubarShortcut>Ctrl+N</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => openProject()}>
            <FolderOpen />
            Abrir…
            <MenubarShortcut>Ctrl+O</MenubarShortcut>
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={!recent.length}>Abrir reciente</MenubarSubTrigger>
            <MenubarSubContent className="max-w-md">
              {recent.map((path) => (
                <MenubarItem key={path} onSelect={() => openProject(path)} title={path}>
                  <span className="truncate">{path}</span>
                </MenubarItem>
              ))}
              <MenubarSeparator />
              <MenubarItem onSelect={clearRecent}>Vaciar lista</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem onSelect={saveProject}>
            <Save />
            Guardar
            <MenubarShortcut>Ctrl+S</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={saveProjectAs}>
            Guardar como…
            <MenubarShortcut>Ctrl+Mayús+S</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={onImportAudio}>
            <FileAudio />
            Importar audio…
            <MenubarShortcut>Ctrl+I</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={exportWav}>
            Exportar mezcla a WAV…
            <MenubarShortcut>Ctrl+E</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <HelpMenu />
    </Menubar>
  );
}
