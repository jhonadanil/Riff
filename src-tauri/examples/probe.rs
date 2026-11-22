//! Prueba de diagnóstico: carga un plugin VST3 y lo hace sonar sin tarjeta de audio ni interfaz.
//!
//!   cargo run --example probe -- "C:\Program Files\Common Files\VST3\MODO DRUM.vst3"
//!
//! Instrumento (sin entradas de audio): manda una nota y mide la salida.
//! Efecto: le pasa un seno y mide la salida.

use std::time::Instant;

use vst3_host::{AudioBuffers, MidiChannel, MidiEvent, Vst3Host};

fn main() {
    let path = std::env::args().nth(1).expect("uso: probe <ruta al .vst3>");
    // Variantes para aislar problemas: modo de enviar la nota, bloque de proceso y bloque declarado
    let mode = std::env::args().nth(2).unwrap_or_else(|| "event".into());
    let rate = 48_000.0;
    let block: usize = std::env::args().nth(3).and_then(|v| v.parse().ok()).unwrap_or(512);
    let declared: usize = std::env::args().nth(4).and_then(|v| v.parse().ok()).unwrap_or(512);
    #[allow(non_snake_case)]
    let BLOCK = block;
    println!("modo={mode} bloque={block} declarado={declared}");

    let t0 = Instant::now();
    let mut host = Vst3Host::builder()
        .sample_rate(rate)
        .block_size(declared)
        .input_channels(2)
        .output_channels(2)
        .build()
        .expect("host");
    let mut plugin = host.load_plugin(&path).expect("no se pudo cargar");
    let info = plugin.info().clone();
    println!("cargado en {:.1?}: {} ({}) entradas={} salidas={} midi={} gui={}", t0.elapsed(), info.name, info.category, info.audio_inputs, info.audio_outputs, info.has_midi_input, info.has_gui);
    println!("bus: {:?}", plugin.audio_bus_layout());

    plugin.start_processing().expect("start_processing");
    let instrument = info.category.to_lowercase().contains("instrument") || info.audio_inputs == 0;
    println!("modo: {}", if instrument { "instrumento" } else { "efecto" });

    let mut bufs = AudioBuffers::new(2, 2, BLOCK, rate);
    let mut phase = 0f32;
    let mut peak_total = 0f32;
    let mut errors = 0;
    for block in 0..600 {
        for c in 0..2 {
            for i in 0..BLOCK {
                bufs.inputs[c][i] = if instrument {
                    0.0
                } else {
                    phase += 220.0 * std::f32::consts::TAU / rate as f32;
                    0.3 * phase.sin()
                };
            }
            bufs.outputs[c].iter_mut().for_each(|x| *x = 0.0);
        }
        if instrument && block == 10 {
            let notes: Vec<u8> = std::env::var("NOTES").map(|v| v.split(',').filter_map(|n| n.parse().ok()).collect()).unwrap_or_else(|_| vec![36, 38, 42, 60]);
            for note in notes {
                let ev = MidiEvent::NoteOn { channel: MidiChannel::Ch1, note, velocity: 110 };
                let r = match mode.as_str() {
                    "live" => plugin.send_live_midi_event(ev),
                    "at" => plugin.send_midi_event_at(ev, 0),
                    _ => plugin.send_midi_event(ev),
                };
                if let Err(e) = r {
                    println!("error al enviar la nota: {e}");
                }
            }
        }
        if let Err(e) = plugin.process_audio(&mut bufs) {
            errors += 1;
            if errors < 4 {
                println!("error al procesar (bloque {block}): {e}");
            }
            continue;
        }
        let peak = bufs.outputs.iter().flatten().fold(0f32, |m, x| m.max(x.abs()));
        peak_total = peak_total.max(peak);
        if block % 60 == 0 || (instrument && (11..16).contains(&block)) {
            println!("bloque {block:>3}: pico de salida {peak:.4}");
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    println!("RESULTADO: pico máximo {peak_total:.4}, errores {errors}");
    if peak_total < 1e-4 {
        println!("=> el plugin NO produce sonido en esta prueba");
    } else {
        println!("=> el plugin produce sonido");
    }
}
