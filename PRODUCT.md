# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(App de escritorio con Tauri 2 en Windows; la interfaz es web en WebView2.)

## Users
Músicos aficionados —guitarristas y bandas de rock— que quieren grabar en casa sin pelearse con un DAW complicado. La app es pública y gratuita.

## Product Purpose
Riff Studio es un DAW para grabar, editar y mezclar rock en casa. Tiene que ser a la vez simple y rápido (enchufar la guitarra y grabar una idea en segundos sin perderse en menús) y traer de serie lo que el rock necesita: amplis, pedales y batería, sin tener que buscar plugins.

## Positioning
Un DAW centrado en el rock y pensado para aficionados: menos opciones que un DAW generalista y todo lo necesario para el rock incluido de serie.

## Operating Context
Se usa en dos situaciones por igual:
- **Grabando:** con la guitarra en las manos delante del ordenador. Se mira la pantalla de reojo y se usa mucho el teclado (Espacio, R, S, M, L…).
- **Editando y mezclando:** sentado con el ratón, ajustando clips, recortes y la mezcla con calma.

Entrada de audio a través de una tarjeta o interfaz USB, normalmente con la guitarra en una entrada mono (p. ej. la entrada 2).

## Capabilities and Constraints
- Hecho: importar audio, línea de tiempo con rejilla, recorte, división, deshacer, pistas, mixer (volumen, panorama, mute, solo), metrónomo, loop, guardar y abrir proyectos `.riff`, exportar a WAV, elegir la entrada de audio y monitorizarla.
- Previsto (ver ROADMAP.md): grabación con cuenta previa, compensación de latencia, cadena de efectos y amplis, afinador, batería por pasos, motor nativo en Rust con ASIO y plugins VST3/CLAP, IA, instalador.
- Interfaz en español.
- Stack: Tauri 2, React, Tailwind v4, shadcn/ui, Zustand y Tone.js.

## Brand Commitments
- Nombre: **Riff Studio** (antes «Riff»; el repositorio y la extensión de proyecto `.riff` se mantienen).
- El usuario pidió una apariencia minimalista y monocroma, tomando como referencia la interfaz de escritorio de Ollama, con modo claro y modo oscuro. Sirve de referencia de estilo, no de marca: no se copian su logotipo ni su identidad.

## Evidence on Hand
No hay testimonios, usuarios ni cifras. No inventarlos.

## Product Principles
1. Del enchufe a la toma en segundos: grabar nunca debe esperar a la configuración.
2. Legible de reojo: el estado importante (grabando, armado, nivel, saturación) se entiende sin mirar fijamente.
3. Teclado primero, sin dejar fuera al ratón.
4. Rock de serie: lo esencial viene incluido; lo avanzado no estorba.
