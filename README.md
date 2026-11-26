# Riff Studio

DAW de escritorio enfocado en rock: amplis, pedales y batería gratis integrados, inspirado en Reaper, con IA en el futuro.

**Web:** https://jhonadanil.github.io/riff-studio/ · **Descargar:** https://github.com/jhonadanil/riff-studio/releases/latest

## Licencia

Software propietario, con todos los derechos reservados: la app es gratuita, pero el código no es de uso libre. Ver [LICENSE](LICENSE).

## Stack

| Capa | Tecnología | Para qué |
| --- | --- | --- |
| Escritorio | **Tauri 2** (Rust) | Ventana nativa, acceso a disco y, más adelante, el motor de audio en tiempo real y el hosting de VST3/CLAP |
| UI | **React 19 + TypeScript + Vite** | Interfaz |
| Estilos | **Tailwind CSS v4** | Utilidades CSS (config en `src/index.css`) |
| Componentes | **shadcn/ui** (Radix, preset Nova) | Botones, sliders/faders, menús, paneles redimensionables... en `src/components/ui` |
| Diseño | **Impeccable** | Skills de diseño para Claude Code (`/impeccable ...`) en `.claude/` |
| Estado | **Zustand** | Estado del proyecto (pistas, transporte) en `src/store` |
| Audio (prototipo) | **Tone.js** | Transporte y audio vía Web Audio mientras se construye el motor en Rust |
| Formas de onda | **wavesurfer.js** | Clips de audio en la línea de tiempo |
| Iconos / animación | **lucide-react**, **motion** | |

## Estructura

```
src/
  audio/        audio en la interfaz (Tone.js) y puente con el motor nativo
  components/ui componentes shadcn
  features/     transport, tracks, mixer...
  plugins/      UIs de amplis, pedales y batería
  store/        estado global (Zustand)
src-tauri/      backend Rust de Tauri: motor de audio y plugins
```

## Comandos

```bash
pnpm install       # instalar dependencias
pnpm tauri dev     # abrir la app de escritorio en modo desarrollo
pnpm dev           # solo la UI en el navegador (http://localhost:1420)
pnpm tauri build   # generar el instalador
pnpm dlx shadcn@latest add <componente>   # añadir componentes shadcn
```
