# Riff · Lista de tareas

Marca `[x]` = hecho. El orden es el orden de trabajo recomendado.

## Fase 0 · Base
- [x] Scaffold Tauri 2 + React + Tailwind + shadcn + Zustand + Tone.js
- [x] Repo en GitHub (jhonadanil/Riff)

## Fase 1 · Edición básica (motor Tone.js)
- [x] Importar audio (arrastrar o botón) como clips con forma de onda
- [x] Reproducir / pausar / volver al inicio, cursor y regla de compases
- [x] Zoom horizontal (botones y Ctrl + rueda)
- [x] Mixer conectado al audio: volumen, pan, mute, solo
- [x] Ajuste a la rejilla (snap a tiempo/compás), activable
- [x] Mover clips entre pistas
- [x] Seleccionar clip; borrar con Supr
- [x] Recortar bordes de un clip (trim)
- [x] Dividir clip en el cursor (tecla S)
- [x] Deshacer / rehacer (Ctrl+Z / Ctrl+Y)
- [x] Añadir, renombrar y eliminar pistas
- [x] Metrónomo
- [x] Región de loop
- [x] Atajos de teclado (Espacio, Inicio, S, Supr, Ctrl+Z/Y, M, L, G)

## Fase 2 · Proyecto
- [x] Guardar / abrir proyecto (`.riff` + carpeta `Audio/`) con diálogos nativos de Tauri
- [x] Exportar la mezcla a WAV (24 bits)
- [x] Proyectos recientes y autoguardado (cada 2 min si ya tiene archivo)
- [x] Aviso de cambios sin guardar al cerrar, abrir o crear proyecto

## Fase 3 · Grabación
- [x] Elegir entrada de audio (interfaz / micro) y monitorizar
- [x] Grabar en las pistas armadas, con cuenta previa
- [ ] Compensación de latencia

## Fase 4 · Motor nativo (Rust)
Va antes que los amplis y pedales: así se escriben una sola vez, ya en tiempo real.
- [ ] Motor de audio en Rust (cpal) con ASIO en Windows: elegir driver, dispositivo y tamaño de búfer
- [ ] Monitorización de la entrada en tiempo real (baja latencia) desde el motor nativo
- [ ] Puente UI ↔ motor mediante comandos/eventos de Tauri
- [ ] Reproducción de clips, mixer y metrónomo en el motor nativo
- [ ] Grabación en el motor nativo (con compensación de latencia)
- [ ] Exportar la mezcla desde el motor nativo
- [ ] Hosting de plugins VST3 / CLAP

## Fase 5 · Rock: amplis, pedales y batería
- [ ] Cadena de efectos por pista (insertar, reordenar, bypass)
- [ ] Pedales: overdrive, distorsión, fuzz, delay, chorus, reverb, noise gate
- [ ] Ampli: previo + EQ + simulación de pantalla (respuestas impulso / IR)
- [ ] Afinador
- [ ] Batería: sampler con kits gratis + secuenciador por pasos y patrones

## Fase 6 · IA
- [ ] Ideas a definir: generar baterías, sugerir tonos de ampli, separar pistas, mezcla asistida

## Fase 7 · Distribución
- [ ] Instalador para Windows, auto-actualización
- [ ] CI en GitHub Actions (build + checks)
