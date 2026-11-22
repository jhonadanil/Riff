//! Pruebas de la cadena con plugins reales instalados (se saltan si no están).
use std::time::Duration;

use vst3_host::Vst3Host;

use super::*;

const VST: &str = r"C:\Program Files\Common Files\VST3";
const RATE: f64 = 48_000.0;
const N: usize = 256;

fn load(name: &str) -> Option<Arc<Mutex<Plugin>>> {
    let path = format!("{VST}/{name}");
    if !std::path::Path::new(&path).exists() {
        eprintln!("(no está {name}: prueba omitida)");
        return None;
    }
    let mut host = Vst3Host::builder().sample_rate(RATE).block_size(MAX_BLOCK).input_channels(2).output_channels(2).build().ok()?;
    let mut p = host.load_plugin(&path).ok()?;
    p.start_processing().ok()?;
    Some(Arc::new(Mutex::new(p)))
}

fn slot(id: u32, p: Arc<Mutex<Plugin>>, instrument: bool) -> Slot {
    Slot { id, instrument, plugin: p, bypass: Arc::new(AtomicBool::new(false)) }
}

/// Un bloque de entrada: entrada 1 = seno, entrada 2 = silencio.
fn block(sc: &mut Scratch, bufs: &mut AudioBuffers, phase: &mut f32) {
    sc.raw[0].clear();
    sc.raw[1].clear();
    for _ in 0..N {
        *phase += 220.0 * std::f32::consts::TAU / RATE as f32;
        sc.raw[0].push(0.3 * phase.sin());
        sc.raw[1].push(0.0);
    }
    for c in 0..2 {
        bufs.inputs[c].clear();
        bufs.inputs[c].extend_from_slice(&sc.raw[0]);
    }
}

fn peak(bufs: &AudioBuffers, c: usize) -> f32 {
    bufs.inputs[c].iter().fold(0f32, |m, x| m.max(x.abs()))
}

fn run(chain: &Chain, blocks: usize) -> (f32, f32) {
    let mut sc = Scratch::new();
    let mut bufs = AudioBuffers::new(2, 2, N, RATE);
    let mut phase = 0f32;
    let (mut pl, mut pr) = (0f32, 0f32);
    for _ in 0..blocks {
        block(&mut sc, &mut bufs, &mut phase);
        chain.process(&mut bufs, &mut sc);
        pl = pl.max(peak(&bufs, 0));
        pr = pr.max(peak(&bufs, 1));
        std::thread::sleep(Duration::from_millis(3));
    }
    (pl, pr)
}

#[test]
fn pista_sin_plugins_suena_directa_por_su_entrada() {
    let chain = Chain::default();
    *chain.monitored.lock().unwrap() = vec!["gtr".into()];
    chain.set_inputs([("gtr".to_string(), 0u8)].into());
    let (l, r) = run(&chain, 10);
    assert!(l > 0.25 && r > 0.25, "directa por la entrada 1: {l} {r}");

    // Con la entrada 2 (silencio) no debe sonar nada
    chain.set_inputs([("gtr".to_string(), 1u8)].into());
    let (l, r) = run(&chain, 10);
    assert!(l < 1e-6 && r < 1e-6, "entrada 2 vacía: {l} {r}");
}

#[test]
fn sin_pistas_monitorizadas_no_sale_nada() {
    let chain = Chain::default();
    let (l, r) = run(&chain, 5);
    assert!(l < 1e-6 && r < 1e-6);
}

#[test]
fn efecto_en_la_pista_procesa_la_entrada() {
    let Some(fx) = load("Tonocracy.vst3") else { return };
    let chain = Chain::default();
    chain.tracks.lock().unwrap().insert("gtr".into(), vec![slot(1, fx, false)]);
    *chain.monitored.lock().unwrap() = vec!["gtr".into()];
    chain.set_inputs([("gtr".to_string(), 0u8)].into());
    let (l, r) = run(&chain, 40);
    assert!(l > 0.05 && r > 0.05, "el efecto no deja pasar sonido: {l} {r}");
}

#[test]
fn dos_pistas_cada_una_con_su_entrada() {
    let chain = Chain::default();
    *chain.monitored.lock().unwrap() = vec!["a".into(), "b".into()];
    // a = entrada 1 (seno), b = entrada 2 (silencio): suena solo a
    chain.set_inputs([("a".to_string(), 0u8), ("b".to_string(), 1u8)].into());
    let (l, _) = run(&chain, 10);
    assert!(l > 0.25 && l < 0.35, "solo debe sonar la pista a: {l}");
}

#[test]
fn instrumento_toca_con_midi_en_vivo() {
    let Some(drum) = load("MODO DRUM.vst3") else { return };
    let chain = Chain::default();
    chain.tracks.lock().unwrap().insert("bat".into(), vec![slot(1, drum, true)]);
    *chain.monitored.lock().unwrap() = vec!["bat".into()];
    chain.set_inputs([("bat".to_string(), 0u8)].into());
    let mut sc = Scratch::new();
    let mut bufs = AudioBuffers::new(2, 2, N, RATE);
    let mut phase = 0f32;
    let mut top = 0f32;
    for i in 0..200 {
        if i == 5 {
            // Un MODO DRUM sin kit solo responde a la nota 60
            chain.send_midi("maschine", MidiEvent::NoteOn { channel: vst3_host::MidiChannel::Ch1, note: 60, velocity: 110 });
        }
        block(&mut sc, &mut bufs, &mut phase);
        chain.process(&mut bufs, &mut sc);
        top = top.max(peak(&bufs, 0)).max(peak(&bufs, 1));
        std::thread::sleep(Duration::from_millis(3));
    }
    eprintln!("batería en vivo: pico {top}");
    assert!(top > 0.002, "el instrumento no suena con MIDI en vivo: {top}");
    // Y la guitarra (seno) no debe colarse: el pico del seno sería ~0.3
    assert!(top < 0.25, "se cuela la entrada de guitarra en la pista del instrumento: {top}");
}

#[test]
fn instrumento_toca_clips_midi_al_reproducir() {
    let Some(drum) = load("MODO DRUM.vst3") else { return };
    let chain = Chain::default();
    chain.tracks.lock().unwrap().insert("bat".into(), vec![slot(1, drum, true)]);
    // Sin monitorizar: solo suena porque la canción está reproduciendo
    chain.set_clips([("bat".to_string(), vec![NoteIn { start: 0.05, dur: 0.2, note: 60, vel: 110, ch: 0 }])].into());
    chain.play(0.0, 0.0);
    let mut sc = Scratch::new();
    let mut bufs = AudioBuffers::new(2, 2, N, RATE);
    let mut phase = 0f32;
    let mut top = 0f32;
    for _ in 0..200 {
        block(&mut sc, &mut bufs, &mut phase);
        chain.process(&mut bufs, &mut sc);
        top = top.max(peak(&bufs, 0)).max(peak(&bufs, 1));
        std::thread::sleep(Duration::from_millis(3));
    }
    chain.stop();
    eprintln!("clip MIDI: pico {top}");
    assert!(top > 0.002, "el clip MIDI no suena al reproducir: {top}");
}

#[test]
fn instrumento_armado_suena_sin_monitorizar() {
    let Some(drum) = load("MODO DRUM.vst3") else { return };
    let chain = Chain::default();
    chain.tracks.lock().unwrap().insert("bat".into(), vec![slot(1, drum, true)]);
    // Armada, sin auriculares: tocar el controlador debe sonar
    chain.set_armed(vec!["bat".into()]);
    let mut sc = Scratch::new();
    let mut bufs = AudioBuffers::new(2, 2, N, RATE);
    let mut phase = 0f32;
    let mut top = 0f32;
    for i in 0..200 {
        if i == 5 {
            chain.send_midi("maschine", MidiEvent::NoteOn { channel: vst3_host::MidiChannel::Ch1, note: 60, velocity: 110 });
        }
        block(&mut sc, &mut bufs, &mut phase);
        chain.process(&mut bufs, &mut sc);
        top = top.max(peak(&bufs, 0)).max(peak(&bufs, 1));
        std::thread::sleep(Duration::from_millis(3));
    }
    assert!(top > 0.002, "una pista armada con instrumento no suena: {top}");
    assert!(top < 0.25, "se cuela la guitarra: {top}");
}

#[test]
fn guitarra_armada_sin_monitor_no_suena() {
    let chain = Chain::default();
    chain.set_armed(vec!["gtr".into()]);
    chain.set_inputs([("gtr".to_string(), 0u8)].into());
    let (l, r) = run(&chain, 10);
    assert!(l < 1e-6 && r < 1e-6, "armar una pista de audio no debe oírse: {l} {r}");
}

#[test]
fn grabacion_nativa_limpia_y_con_efectos() {
    let Some(fx) = load("Tonocracy.vst3") else { return };
    let chain = Chain::default();
    chain.tracks.lock().unwrap().insert("wet".into(), vec![slot(1, fx, false)]);
    chain.set_inputs([("dry".to_string(), 0u8), ("wet".to_string(), 0u8), ("sil".to_string(), 1u8)].into());
    // Nada se escucha: solo se graba
    let modes = chain.start_audio_rec(&[("dry".into(), false), ("wet".into(), true), ("sil".into(), false)]);
    assert_eq!(modes, vec![("dry".to_string(), false), ("wet".to_string(), true), ("sil".to_string(), false)]);
    let (l, _) = run(&chain, 40);
    assert!(l < 1e-6, "grabar no debe sonar por los altavoces: {l}");
    let takes = chain.stop_audio_rec();
    let peak_of = |name: &str| {
        let (_, _, _, data) = takes.iter().find(|t| t.0 == name).expect("falta la toma");
        assert!(data.len() > 2 * N * 20, "toma demasiado corta: {}", data.len());
        data.iter().fold(0f32, |m, x| m.max(x.abs()))
    };
    let dry = peak_of("dry");
    let wet = peak_of("wet");
    let sil = peak_of("sil");
    eprintln!("limpia {dry} · con efectos {wet} · entrada 2 vacía {sil}");
    assert!((dry - 0.3).abs() < 0.02, "la limpia debe ser la entrada tal cual: {dry}");
    assert!(wet > 0.05, "con efectos debe llevar sonido: {wet}");
    assert!(sil < 1e-6, "la entrada 2 está vacía: {sil}");
}

#[test]
fn pista_sin_efectos_que_pide_efectos_se_graba_limpia() {
    let chain = Chain::default();
    let modes = chain.start_audio_rec(&[("a".into(), true)]);
    assert_eq!(modes, vec![("a".to_string(), false)]);
    chain.stop_audio_rec();
}
