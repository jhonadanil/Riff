//! La cadena de plugins que ve el callback de audio, el secuenciador MIDI y la grabación desde el
//! motor nativo.
//!
//! Todo lo de aquí corre en el hilo de audio del driver: solo `try_lock`, nada de esperas, y la
//! memoria de trabajo se reserva antes (`Scratch`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use vst3_host::{AudioBuffers, MidiEvent, Plugin};

/// Tamaño máximo de bloque que se le declara al plugin; los bloques mayores se parten solos.
pub(super) const MAX_BLOCK: usize = 1024;
const DEFAULT_RATE: f64 = 48_000.0;

// --- Cadenas (las ve el callback de audio) ---------------------------------------------

pub(super) struct Slot {
    pub(super) id: u32,
    /// Instrumento (batería, sintetizador…): genera audio a partir de MIDI, no procesa la entrada.
    pub(super) instrument: bool,
    pub(super) plugin: Arc<Mutex<Plugin>>,
    pub(super) bypass: Arc<AtomicBool>,
}

/// Memoria de trabajo del callback (se reserva una vez, no se pide memoria en el callback).
pub struct Scratch {
    /// Pistas (su hash) cuya cadena ya ha corrido en este bloque: ninguna debe procesarse dos veces.
    done: Vec<u64>,
    /// Latencia de entrada medida por el driver (s), para fechar lo que se graba.
    pub latency: f64,
    /// Señal cruda de la interfaz: entrada 1 y entrada 2 (la rellena el callback de entrada).
    pub raw: [Vec<f32>; 2],
    dry: [Vec<f32>; 2],
    mix: [Vec<f32>; 2],
}

impl Scratch {
    pub fn new() -> Self {
        let v = || Vec::with_capacity(8192);
        Self { done: Vec::with_capacity(64), latency: 0.0, raw: [v(), v()], dry: [v(), v()], mix: [v(), v()] }
    }
}

/// Una nota de un clip MIDI, con su posición absoluta en la línea de tiempo (segundos).
#[derive(Deserialize, Clone)]
pub struct NoteIn {
    pub start: f64,
    pub dur: f64,
    pub note: u8,
    pub vel: u8,
    /// Canal MIDI (0-15).
    pub ch: u8,
}

#[derive(Clone, Copy)]
pub(super) struct SeqEv {
    pub(super) t: f64,
    pub(super) on: bool,
    pub(super) note: u8,
    pub(super) vel: u8,
    pub(super) ch: u8,
}

/// Estado del secuenciador: dónde está la canción y qué notas tocar.
#[derive(Default)]
struct Seq {
    /// Eventos por pista, ordenados por tiempo.
    events: HashMap<String, Vec<SeqEv>>,
    playing: bool,
    /// La posición de la canción ahora es `reloj - origin + offset`.
    origin: f64,
    /// Hasta dónde se han mandado notas ya.
    last: f64,
    /// Ajuste de sincronía con el audio de las pistas (segundos).
    offset: f64,
    /// Volumen y si se oye (mute/solo) de cada pista con instrumento.
    mix: HashMap<String, (f32, bool)>,
}

/// Notas -> eventos de encendido y apagado, ordenados por tiempo.
pub(super) fn build_events(notes: &[NoteIn]) -> Vec<SeqEv> {
    let mut evs: Vec<SeqEv> = notes
        .iter()
        .flat_map(|n| {
            [
                SeqEv { t: n.start, on: true, note: n.note, vel: n.vel.max(1), ch: n.ch },
                SeqEv { t: n.start + n.dur.max(0.01), on: false, note: n.note, vel: 0, ch: n.ch },
            ]
        })
        .collect();
    evs.sort_by(|a, b| a.t.total_cmp(&b.t));
    evs
}

/// Un WAV de 32 bits en coma flotante, estéreo.
pub(super) fn wav_f32(left: &[f32], right: &[f32], rate: u32) -> Vec<u8> {
    let data = left.len() * 8;
    let mut w = Vec::with_capacity(44 + data);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&3u16.to_le_bytes()); // coma flotante
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 8).to_le_bytes());
    w.extend_from_slice(&8u16.to_le_bytes());
    w.extend_from_slice(&32u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(data as u32).to_le_bytes());
    for (l, r) in left.iter().zip(right) {
        w.extend_from_slice(&l.to_le_bytes());
        w.extend_from_slice(&r.to_le_bytes());
    }
    w
}

const CHUNK: usize = 48_000 * 2 * 2;

/// Lo que sale de la cadena de una pista mientras se graba "con efectos".
struct TrackRec {
    /// Con efectos (lo que sale de los plugins) o limpia (la señal de la entrada tal cual).
    wet: bool,
    /// Segundos desde el inicio de la toma en que cae la primera muestra.
    first: Option<f64>,
    /// Muestras estéreo intercaladas, en bloques de ~2 s.
    chunks: Vec<Vec<f32>>,
    cur: Vec<f32>,
}

struct AudioRec {
    t0: std::time::Instant,
    rate: f64,
    tracks: HashMap<String, TrackRec>,
}

type RecGuard<'a> = Option<std::sync::MutexGuard<'a, Option<AudioRec>>>;

/// Anota en la toma lo que le llega a la pista en este bloque: `wet` = lo que sale de sus plugins;
/// si no, la señal limpia de su entrada. Solo se anota si coincide con el modo de la pista.
fn capture(rec: &mut RecGuard<'_>, track: &str, left: &[f32], right: &[f32], rate: f64, latency: f64, wet: bool) {
    let Some(r) = rec.as_mut().and_then(|g| g.as_mut()) else { return };
    r.rate = rate;
    let t0 = r.t0;
    let Some(t) = r.tracks.get_mut(track) else { return };
    if t.wet != wet {
        return;
    }
    if t.first.is_none() {
        t.first = Some(t0.elapsed().as_secs_f64() - latency);
    }
    for (l, x) in left.iter().zip(right) {
        if t.cur.len() + 2 > t.cur.capacity() {
            let full = std::mem::replace(&mut t.cur, Vec::with_capacity(CHUNK));
            t.chunks.push(full);
        }
        t.cur.push(*l);
        t.cur.push(*x);
    }
}

/// Identificador barato de una pista (sin reservar memoria) para saber si ya se procesó en este bloque.
fn key(track: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    track.hash(&mut h);
    h.finish()
}

/// Deja en silencio la señal del bloque.
fn silence(bufs: &mut AudioBuffers) {
    for ch in bufs.inputs.iter_mut() {
        ch.iter_mut().for_each(|x| *x = 0.0);
    }
}

/// Reloj común del secuenciador.
fn base() -> &'static std::time::Instant {
    static B: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    B.get_or_init(std::time::Instant::now)
}

#[derive(Default)]
pub struct Chain {
    /// Se está exportando: el audio en vivo se aparta mientras los plugins se usan para renderizar.
    pub(super) exporting: AtomicBool,
    /// Entrada de cada pista, por id de pista.
    inputs: Mutex<HashMap<String, u8>>,
    /// Dispositivo MIDI de cada pista (vacío o ausente = cualquiera).
    midi_ports: Mutex<HashMap<String, String>>,
    /// Toma de audio con efectos en curso.
    rec_audio: Mutex<Option<AudioRec>>,
    /// Pistas de la toma con efectos en curso (para recorrerlas sin reservar memoria en el callback).
    rec_names: Mutex<Vec<String>>,
    recording: AtomicBool,
    seq: Mutex<Seq>,
    playing: std::sync::atomic::AtomicBool,
    /// Plugins de cada pista, por id de pista.
    pub(super) tracks: Mutex<HashMap<String, Vec<Slot>>>,
    /// Pistas que se están monitorizando ahora.
    pub(super) monitored: Mutex<Vec<String>>,
    /// Pistas armadas (si tienen un instrumento, suenan al tocar aunque no se monitoricen).
    armed: Mutex<Vec<String>>,
    armed_any: AtomicBool,
    sample_rate: Mutex<Option<f64>>,
}

impl Chain {
    /// Procesa la señal de entrada y deja en `bufs.inputs` el resultado: la suma de
    ///   - cada pista que se escucha (con su entrada elegida): su cadena de plugins o, sin ellos, la señal directa;
    ///   - los instrumentos de las pistas con clips MIDI mientras suena la canción.
    /// La señal cruda de la interfaz (entradas 1 y 2) viene en `sc.raw`.
    pub fn process(&self, bufs: &mut AudioBuffers, sc: &mut Scratch) {
        // Si no se puede procesar este bloque, mejor silencio que dejar pasar la señal sin los plugins
        // (un golpe de guitarra limpia a los auriculares)
        if self.exporting.load(Ordering::Relaxed) {
            silence(bufs);
            return;
        }
        let (Ok(tracks), Ok(monitored), Ok(inputs), Ok(armed)) =
            (self.tracks.try_lock(), self.monitored.try_lock(), self.inputs.try_lock(), self.armed.try_lock())
        else {
            silence(bufs);
            return;
        };
        let mut rec = self.rec_audio.try_lock().ok();
        let n = sc.raw[0].len();
        let sr = bufs.sample_rate;
        sc.done.clear();
        for c in 0..2 {
            sc.mix[c].clear();
            sc.mix[c].resize(n, 0.0);
        }

        // Secuenciador: mandar a los instrumentos las notas que caen en este bloque
        let mut seq = self.seq.try_lock().ok();
        let playing = seq.as_ref().is_some_and(|s| s.playing);
        if let Some(seq) = seq.as_mut().filter(|s| s.playing) {
            let now = base().elapsed().as_secs_f64();
            let pos = now - seq.origin + seq.offset;
            let w0 = seq.last.max(pos);
            let w1 = pos + n as f64 / sr;
            if w1 > w0 {
                for (track, evs) in seq.events.iter() {
                    let Some(first) = tracks.get(track).and_then(|s| s.first()) else { continue };
                    if !first.instrument || first.bypass.load(Ordering::Relaxed) {
                        continue;
                    }
                    let lo = evs.partition_point(|e| e.t < w0);
                    let hi = evs.partition_point(|e| e.t < w1);
                    if lo == hi {
                        continue;
                    }
                    let Ok(mut p) = first.plugin.try_lock() else { continue };
                    for e in &evs[lo..hi] {
                        let channel = vst3_host::MidiChannel::from_index(e.ch).unwrap_or(vst3_host::MidiChannel::Ch1);
                        let ev = if e.on {
                            MidiEvent::NoteOn { channel, note: e.note, velocity: e.vel }
                        } else {
                            MidiEvent::NoteOff { channel, note: e.note, velocity: 0 }
                        };
                        let offset = (((e.t - pos).max(0.0) * sr) as i32).clamp(0, n as i32 - 1);
                        let _ = p.send_midi_event_at(ev, offset);
                    }
                }
                seq.last = w1;
            }
        }

        // Una pista: pasa su señal (o silencio, si es un instrumento) por su cadena y la suma
        let run = |track: &str, slots: &Vec<Slot>, gain: f32, bufs: &mut AudioBuffers, sc: &mut Scratch, rec: &mut RecGuard<'_>| {
            // Un instrumento arranca de silencio: lo que suena es lo que toca el MIDI
            let instrument = slots.first().is_some_and(|s| s.instrument);
            for c in 0..2 {
                bufs.inputs[c].clear();
                if instrument {
                    bufs.inputs[c].resize(n, 0.0);
                } else {
                    bufs.inputs[c].extend_from_slice(&sc.dry[c]);
                }
            }
            for s in slots {
                if s.bypass.load(Ordering::Relaxed) {
                    continue;
                }
                let Ok(mut p) = s.plugin.try_lock() else { continue };
                for ch in bufs.outputs.iter_mut() {
                    ch.clear();
                    ch.resize(n, 0.0);
                }
                bufs.block_size = n;
                if p.process_audio(bufs).is_ok() {
                    // La salida de este plugin es la entrada del siguiente
                    std::mem::swap(&mut bufs.inputs, &mut bufs.outputs);
                }
            }
            capture(rec, track, &bufs.inputs[0], &bufs.inputs[1], sr, sc.latency, true);
            for c in 0..2 {
                for (m, x) in sc.mix[c].iter_mut().zip(&bufs.inputs[c]) {
                    *m += *x * gain;
                }
            }
        };

        for track in monitored.iter() {
            sc.done.push(key(track));
            // La entrada de esta pista: 0 = entrada 1, 1 = entrada 2, 2 = las dos (estéreo)
            let (l, r) = match inputs.get(track).copied().unwrap_or(0) {
                0 => (0, 0),
                1 => (1, 1),
                _ => (0, 1),
            };
            sc.dry[0].clear();
            sc.dry[0].extend_from_slice(&sc.raw[l]);
            sc.dry[1].clear();
            sc.dry[1].extend_from_slice(&sc.raw[r]);
            capture(&mut rec, track, &sc.dry[0], &sc.dry[1], sr, sc.latency, false);
            let slots = tracks.get(track).filter(|s| s.iter().any(|s| !s.bypass.load(Ordering::Relaxed)));
            match slots {
                Some(slots) => run(track, slots, 1.0, bufs, sc, &mut rec),
                None => {
                    // Sin plugins: la señal directa
                    for c in 0..2 {
                        for (m, x) in sc.mix[c].iter_mut().zip(&sc.dry[c]) {
                            *m += *x;
                        }
                    }
                }
            }
        }
        // Instrumentos de pistas armadas: se tocan en vivo aunque no se monitoricen
        for track in armed.iter() {
            if sc.done.contains(&key(track)) {
                continue;
            }
            if let Some(slots) = tracks.get(track).filter(|s| s.first().is_some_and(|s| s.instrument && !s.bypass.load(Ordering::Relaxed))) {
                sc.done.push(key(track));
                run(track, slots, 1.0, bufs, sc, &mut rec);
            }
        }
        // Pistas que graban "con efectos" sin escucharse: su cadena corre igual, sin sonar
        let rec_names = self.rec_names.try_lock().ok();
        for track in rec_names.iter().flat_map(|g| g.iter()) {
            if sc.done.contains(&key(track)) {
                continue;
            }
            sc.done.push(key(track));
            let (l, r) = match inputs.get(track).copied().unwrap_or(0) {
                0 => (0, 0),
                1 => (1, 1),
                _ => (0, 1),
            };
            sc.dry[0].clear();
            sc.dry[0].extend_from_slice(&sc.raw[l]);
            sc.dry[1].clear();
            sc.dry[1].extend_from_slice(&sc.raw[r]);
            capture(&mut rec, track, &sc.dry[0], &sc.dry[1], sr, sc.latency, false);
            let wet = rec.as_ref().and_then(|g| g.as_ref()).and_then(|r| r.tracks.get(track)).is_some_and(|t| t.wet);
            if let (true, Some(slots)) = (wet, tracks.get(track)) {
                run(track, slots, 0.0, bufs, sc, &mut rec);
            }
        }
        // Instrumentos con clips MIDI que suenan con la canción (si no se están ya escuchando)
        if let (true, Some(seq)) = (playing, seq.as_ref()) {
            for track in seq.events.keys() {
                if sc.done.contains(&key(track)) {
                    continue;
                }
                let (gain, audible) = seq.mix.get(track).copied().unwrap_or((1.0, true));
                let Some(slots) = tracks.get(track).filter(|s| s.first().is_some_and(|s| s.instrument)) else { continue };
                if audible {
                    sc.done.push(key(track));
                    run(track, slots, gain, bufs, sc, &mut rec);
                }
            }
        }

        for c in 0..2 {
            bufs.inputs[c].clear();
            bufs.inputs[c].extend_from_slice(&sc.mix[c]);
        }
    }

    /// Entrada de cada pista (0 = entrada 1, 1 = entrada 2, 2 = estéreo).
    pub fn set_inputs(&self, inputs: HashMap<String, u8>) {
        *self.inputs.lock().unwrap() = inputs;
    }

    /// Pistas armadas (para que sus instrumentos suenen al tocarlos).
    pub fn set_armed(&self, tracks: Vec<String>) {
        self.armed_any.store(!tracks.is_empty(), Ordering::Relaxed);
        *self.armed.lock().unwrap() = tracks;
    }

    /// ¿Hay alguna pista armada?
    pub fn has_armed(&self) -> bool {
        self.armed_any.load(Ordering::Relaxed)
    }

    /// ¿Se está grabando con efectos? (la cadena tiene que correr aunque nada se escuche)
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    /// ¿Está sonando la canción con clips MIDI? (para que la salida se oiga aunque no se monitorice)
    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    /// Por pista: cuántos plugins lleva y si el primero es un instrumento (la pista es entonces de MIDI).
    pub fn overview(&self) -> HashMap<String, (usize, bool)> {
        self.tracks
            .lock()
            .unwrap()
            .iter()
            .map(|(id, slots)| (id.clone(), (slots.len(), slots.first().is_some_and(|s| s.instrument))))
            .collect()
    }

    /// Pistas (de las dadas) cuyo primer plugin es un instrumento: las que graban MIDI.
    pub fn instrument_tracks(&self, ids: &[String]) -> Vec<String> {
        let tracks = self.tracks.lock().unwrap();
        ids.iter().filter(|id| tracks.get(*id).and_then(|s| s.first()).is_some_and(|s| s.instrument)).cloned().collect()
    }

    /// Sustituye los clips MIDI (notas con tiempos absolutos en la línea de tiempo, en segundos).
    pub fn set_clips(&self, clips: HashMap<String, Vec<NoteIn>>) {
        let events = clips.into_iter().map(|(track, notes)| (track, build_events(&notes))).collect();
        self.seq.lock().unwrap().events = events;
    }

    pub fn set_mix(&self, mix: HashMap<String, (f32, bool)>) {
        self.seq.lock().unwrap().mix = mix;
    }

    pub fn set_offset(&self, seconds: f64) {
        self.seq.lock().unwrap().offset = seconds;
    }

    /// La canción empieza (o salta) a `position` segundos, dentro de `delay` segundos.
    pub fn play(&self, position: f64, delay: f64) {
        let mut s = self.seq.lock().unwrap();
        s.origin = base().elapsed().as_secs_f64() + delay - position;
        s.last = position;
        s.playing = true;
        self.playing.store(true, Ordering::Relaxed);
        drop(s);
        self.panic();
    }

    pub fn stop(&self) {
        self.seq.lock().unwrap().playing = false;
        self.playing.store(false, Ordering::Relaxed);
        self.panic();
    }

    /// Apaga todas las notas que estén sonando en los instrumentos.
    fn panic(&self) {
        for s in self.tracks.lock().unwrap().values().flatten().filter(|s| s.instrument) {
            // Sin esperar: si el plugin está ocupado (abriendo su ventana) no se bloquea nada por esto
            if let Ok(mut p) = s.plugin.try_lock() {
                let _ = p.midi_panic();
            }
        }
    }

    /// Ajusta todos los plugins a la frecuencia de muestreo del motor (se llama al arrancarlo).
    ///
    /// Nunca espera: si un plugin está ocupado (p. ej. abriendo su ventana) se salta, para que
    /// arrancar el motor de audio no se quede colgado por culpa de un plugin.
    pub fn prepare(&self, sample_rate: f64) {
        if let Ok(mut r) = self.sample_rate.try_lock() {
            *r = Some(sample_rate);
        }
        let Ok(tracks) = self.tracks.try_lock() else {
            eprintln!("[plugins] la cadena está ocupada: no se ajusta la frecuencia de muestreo");
            return;
        };
        for s in tracks.values().flatten() {
            let Ok(mut p) = s.plugin.try_lock() else {
                eprintln!("[plugins] un plugin está ocupado: no se ajusta la frecuencia de muestreo");
                continue;
            };
            if (p.sample_rate() - sample_rate).abs() > 0.5 {
                let _ = p.stop_processing();
                let _ = p.reconfigure(sample_rate, MAX_BLOCK);
            }
            let _ = p.start_processing();
        }
    }

    /// Manda un evento MIDI (que llega por `port`) al instrumento de cada pista que se está escuchando
    /// y que toma notas de ese dispositivo.
    pub fn send_midi(&self, port: &str, event: MidiEvent) {
        let (Ok(tracks), Ok(monitored), Ok(armed), Ok(ports)) =
            (self.tracks.lock(), self.monitored.lock(), self.armed.lock(), self.midi_ports.lock())
        else {
            return;
        };
        // Un instrumento suena al tocarlo si su pista está armada o se monitoriza
        for track in armed.iter().chain(monitored.iter().filter(|t| !armed.contains(t))) {
            if !ports.get(track).is_none_or(|p| p.is_empty() || p == port) {
                continue;
            }
            let Some(first) = tracks.get(track).and_then(|s| s.first()) else { continue };
            if !first.instrument || first.bypass.load(Ordering::Relaxed) {
                continue;
            }
            if let Ok(mut p) = first.plugin.lock() {
                let _ = p.send_live_midi_event(event.clone());
            }
        }
    }

    /// Dispositivo MIDI de la pista ("" = cualquiera).
    pub fn midi_port(&self, track: &str) -> String {
        self.midi_ports.lock().unwrap().get(track).cloned().unwrap_or_default()
    }

    pub fn set_midi_ports(&self, ports: HashMap<String, String>) {
        *self.midi_ports.lock().unwrap() = ports;
    }

    /// Pistas (de las dadas) con plugins de efectos (no instrumentos): las que pueden grabar con efectos.
    pub fn fx_tracks(&self, ids: &[String]) -> Vec<String> {
        let tracks = self.tracks.lock().unwrap();
        ids.iter()
            .filter(|id| tracks.get(*id).is_some_and(|s| s.iter().any(|s| !s.instrument && !s.bypass.load(Ordering::Relaxed))))
            .cloned()
            .collect()
    }

    /// Empieza a grabar estas pistas desde el motor nativo: (pista, con efectos). Una pista que pide
    /// efectos pero no lleva plugins de efectos se graba limpia. Devuelve cómo se grabará cada una.
    pub fn start_audio_rec(&self, tracks: &[(String, bool)]) -> Vec<(String, bool)> {
        let with_fx = self.fx_tracks(&tracks.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>());
        let modes: Vec<(String, bool)> =
            tracks.iter().map(|(t, wet)| (t.clone(), *wet && with_fx.contains(t))).collect();
        let map = modes
            .iter()
            .map(|(t, wet)| (t.clone(), TrackRec { wet: *wet, first: None, chunks: Vec::new(), cur: Vec::with_capacity(CHUNK) }))
            .collect();
        *self.rec_names.lock().unwrap() = modes.iter().map(|(t, _)| t.clone()).collect();
        *self.rec_audio.lock().unwrap() = Some(AudioRec { t0: std::time::Instant::now(), rate: 48_000.0, tracks: map });
        self.recording.store(true, Ordering::Relaxed);
        modes
    }

    /// Termina la toma: por cada pista, su desfase (s), la frecuencia y las muestras estéreo intercaladas.
    pub fn stop_audio_rec(&self) -> Vec<(String, f64, u32, Vec<f32>)> {
        self.recording.store(false, Ordering::Relaxed);
        self.rec_names.lock().unwrap().clear();
        let Some(rec) = self.rec_audio.lock().unwrap().take() else { return Vec::new() };
        rec.tracks
            .into_iter()
            .map(|(track, mut t)| {
                let mut data: Vec<f32> = t.chunks.drain(..).flatten().collect();
                data.extend_from_slice(&t.cur);
                (track, t.first.unwrap_or(0.0), rec.rate as u32, data)
            })
            .collect()
    }

    pub(super) fn rate(&self) -> f64 {
        self.sample_rate.lock().unwrap().unwrap_or(DEFAULT_RATE)
    }
}

#[cfg(test)]
mod tests;
