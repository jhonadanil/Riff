//! Plugins VST3 en cada pista (amplis, pedales, voz…).
//!
//!   entrada ─┬─▶ [plugins de la pista A] ─┐
//!            ├─▶ [plugins de la pista B] ─┼─▶ suma ─▶ cola ─▶ salida
//!            └─▶ (pistas sin plugins: directa)
//!
//! Cada pista tiene su propia cadena y solo suenan las de las pistas que se
//! están monitorizando. Los plugins se crean, abren (su ventana) y cierran en
//! un hilo propio (`riff-plugins`) que además bombea los mensajes de las
//! ventanas. El callback de audio solo toca la cadena con `try_lock`: si la
//! interfaz está cambiando algo en ese instante, ese bloque pasa sin procesar
//! en vez de esperar.
//!
//! Módulos: `chain` (lo que corre en el hilo de audio) y este (el hilo de las ventanas, la
//! lista de plugins que ve la interfaz y los comandos de Tauri).

mod chain;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vst3_host::{AudioBuffers, MidiEvent, Plugin, PluginWindow, Vst3Host};

pub use chain::{Chain, NoteIn, Scratch};
use chain::{build_events, wav_f32, Slot, MAX_BLOCK};

/// Los plugins con ventana esperan COM de un hilo con interfaz (apartamento de un solo hilo).
#[cfg(windows)]
fn init_com() {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    // SAFETY: se llama una vez, al empezar el hilo de plugins
    unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    }
}

#[cfg(not(windows))]
fn init_com() {}

/// Reparte los mensajes pendientes de las ventanas de este hilo (dibujar, ratón, teclado, cerrar…).
#[cfg(windows)]
fn pump_os_messages() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE};
    // SAFETY: el MSG es local y se rellena en cada vuelta
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn pump_os_messages() {}

// --- Tipos para la UI -------------------------------------------------------------------

#[derive(Serialize)]
pub struct Available {
    path: String,
    name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlotInfo {
    id: u32,
    name: String,
    vendor: String,
    category: String,
    path: String,
    has_editor: bool,
    editor_open: bool,
    bypass: bool,
    instrument: bool,
}

/// Un plugin tal como se guarda dentro del proyecto.
#[derive(Serialize, Deserialize, Clone)]
pub struct Saved {
    path: String,
    bypass: bool,
    /// Estado interno del plugin (ajustes del ampli, etc.), en hexadecimal.
    state: String,
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Vec<u8> {
    // Por bytes, no por posiciones del texto: un carácter raro en un archivo dañado no debe hacer panic
    s.as_bytes()
        .chunks_exact(2)
        .filter_map(|c| {
            let hi = (c[0] as char).to_digit(16)?;
            let lo = (c[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// Carpetas donde se instalan los VST3 en Windows: solo se cargan plugins de ahí, para que abrir un
/// proyecto ajeno no pueda ejecutar un DLL cualquiera.
fn vst3_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    for (var, tail) in [("CommonProgramFiles", "VST3"), ("CommonProgramW6432", "VST3"), ("CommonProgramFiles(x86)", "VST3"), ("LOCALAPPDATA", "Programs/Common/VST3")] {
        if let Some(base) = std::env::var_os(var) {
            if let Ok(p) = std::path::Path::new(&base).join(tail).canonicalize() {
                roots.push(p);
            }
        }
    }
    roots
}

fn is_installed_vst3(path: &str) -> bool {
    let Ok(p) = std::path::Path::new(path).canonicalize() else { return false };
    vst3_roots().iter().any(|root| p.starts_with(root))
}

// --- Hilo de plugins ----------------------------------------------------------------------

type Reply<T> = mpsc::Sender<Result<T, String>>;

enum Cmd {
    Scan(Reply<Vec<Available>>),
    Load(String, String, Reply<SlotInfo>),
    Remove(u32, Reply<()>),
    Editor(u32, bool, Reply<()>),
    List(String, Reply<Vec<SlotInfo>>),
    Move(u32, i32, Reply<()>),
    Bypass(u32, bool, Reply<()>),
    Prune(Vec<String>, Reply<()>),
    Snapshot(Reply<HashMap<String, Vec<Saved>>>),
    Restore(HashMap<String, Vec<Saved>>, Reply<Vec<String>>),
    /// Los plugins de una sola pista (para guardarlos en una plantilla de pista).
    SnapshotTrack(String, Reply<Vec<Saved>>),
    /// Carga plugins guardados en una pista, sin tocar el resto.
    Apply(String, Vec<Saved>, Reply<Vec<String>>),
    Render(String, Vec<NoteIn>, f64, Reply<Vec<u8>>),
}

pub struct PluginHost {
    tx: Mutex<mpsc::Sender<Cmd>>,
    chain: Arc<Chain>,
}

impl PluginHost {
    pub fn chain(&self) -> Arc<Chain> {
        self.chain.clone()
    }

    pub fn new(chain: Arc<Chain>) -> Self {
        let (tx, rx) = mpsc::channel();
        let c = chain.clone();
        thread::Builder::new()
            .name("riff-plugins".into())
            .spawn(move || Worker::new(c).run(rx))
            .expect("no se pudo crear el hilo de plugins");
        Self { tx: Mutex::new(tx), chain }
    }

    fn call<T>(&self, make: impl FnOnce(Reply<T>) -> Cmd) -> Result<T, String> {
        self.call_for(Duration::from_secs(120), make)
    }

    fn call_for<T>(&self, timeout: Duration, make: impl FnOnce(Reply<T>) -> Cmd) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.tx.lock().unwrap().send(make(tx)).map_err(|_| "El hilo de plugins se ha detenido".to_string())?;
        rx.recv_timeout(timeout).map_err(|_| "El plugin no responde".to_string())?
    }
}

struct Entry {
    track: String,
    info: SlotInfo,
    plugin: Arc<Mutex<Plugin>>,
    bypass: Arc<AtomicBool>,
    window: Option<PluginWindow>,
}

struct Worker {
    chain: Arc<Chain>,
    next_id: AtomicU32,
    /// En orden de carga; el orden dentro de cada pista es el de la cadena.
    entries: Vec<Entry>,
}

impl Worker {
    fn new(chain: Arc<Chain>) -> Self {
        Self { chain, next_id: AtomicU32::new(1), entries: Vec::new() }
    }

    fn run(mut self, rx: mpsc::Receiver<Cmd>) {
        init_com();
        loop {
            match rx.recv_timeout(Duration::from_millis(5)) {
                Ok(cmd) => self.handle(cmd),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Las ventanas de los plugins viven en este hilo: sin atender sus mensajes se quedan
            // congeladas, y Windows termina el proceso entero si se cierra una ventana congelada
            pump_os_messages();
            self.pump_windows();
        }
    }

    /// Mensajes de las ventanas de los plugins; recoger las que el usuario cerró.
    fn pump_windows(&mut self) {
        for e in &mut self.entries {
            let Some(w) = e.window.as_mut() else { continue };
            let _ = w.service_platform_events();
            if w.closed_by_user() || !w.is_open() {
                w.close();
                e.window = None;
                e.info.editor_open = false;
            }
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Scan(r) => {
                let _ = r.send(scan());
            }
            Cmd::Load(track, path, r) => {
                let _ = r.send(self.load(&track, &path, None, false));
            }
            Cmd::Remove(id, r) => {
                self.remove(id);
                let _ = r.send(Ok(()));
            }
            Cmd::Editor(id, open, r) => {
                let _ = r.send(self.set_editor(id, open));
            }
            Cmd::List(track, r) => {
                let _ = r.send(Ok(self.entries.iter().filter(|e| e.track == track).map(|e| e.snapshot()).collect()));
            }
            Cmd::Move(id, dir, r) => {
                self.move_slot(id, dir);
                let _ = r.send(Ok(()));
            }
            Cmd::Bypass(id, on, r) => {
                if let Some(e) = self.entries.iter().find(|e| e.info.id == id) {
                    e.bypass.store(on, Ordering::Relaxed);
                }
                let _ = r.send(Ok(()));
            }
            Cmd::Prune(keep, r) => {
                let gone: Vec<u32> = self.entries.iter().filter(|e| !keep.contains(&e.track)).map(|e| e.info.id).collect();
                for id in gone {
                    self.remove(id);
                }
                let _ = r.send(Ok(()));
            }
            Cmd::Snapshot(r) => {
                let mut out: HashMap<String, Vec<Saved>> = HashMap::new();
                for e in &self.entries {
                    let state = e.plugin.lock().ok().and_then(|p| p.save_state().ok()).map(|s| to_hex(&s)).unwrap_or_default();
                    out.entry(e.track.clone()).or_default().push(Saved {
                        path: e.info.path.clone(),
                        bypass: e.bypass.load(Ordering::Relaxed),
                        state,
                    });
                }
                let _ = r.send(Ok(out));
            }
            Cmd::Render(track, notes, duration, r) => {
                let _ = r.send(self.render(&track, &notes, duration));
            }
            Cmd::SnapshotTrack(track, r) => {
                let out = self
                    .entries
                    .iter()
                    .filter(|e| e.track == track)
                    .map(|e| Saved {
                        path: e.info.path.clone(),
                        bypass: e.bypass.load(Ordering::Relaxed),
                        state: e.plugin.lock().ok().and_then(|p| p.save_state().ok()).map(|s| to_hex(&s)).unwrap_or_default(),
                    })
                    .collect();
                let _ = r.send(Ok(out));
            }
            Cmd::Apply(track, list, r) => {
                let mut errors = Vec::new();
                for s in list {
                    let state = from_hex(&s.state);
                    let st = (!state.is_empty()).then_some(state.as_slice());
                    if let Err(e) = self.load(&track, &s.path, st, s.bypass) {
                        errors.push(format!("{}: {e}", s.path));
                    }
                }
                let _ = r.send(Ok(errors));
            }
            Cmd::Restore(map, r) => {
                let ids: Vec<u32> = self.entries.iter().map(|e| e.info.id).collect();
                for id in ids {
                    self.remove(id);
                }
                let mut errors = Vec::new();
                for (track, list) in map {
                    for s in list {
                        let state = from_hex(&s.state);
                        let st = (!state.is_empty()).then_some(state.as_slice());
                        if let Err(e) = self.load(&track, &s.path, st, s.bypass) {
                            errors.push(format!("{}: {e}", s.path));
                        }
                    }
                }
                let _ = r.send(Ok(errors));
            }
        }
    }

    fn load(&mut self, track: &str, path: &str, state: Option<&[u8]>, bypass: bool) -> Result<SlotInfo, String> {
        if !is_installed_vst3(path) {
            return Err("El plugin no está en una carpeta VST3 estándar (Common Files\\VST3), no se carga".into());
        }
        let rate = self.chain.rate();
        let mut host = Vst3Host::builder()
            .sample_rate(rate)
            .block_size(MAX_BLOCK)
            .input_channels(2)
            .output_channels(2)
            .build()
            .map_err(|e| e.to_string())?;
        let mut plugin = host.load_plugin(path).map_err(|e| format!("No se pudo cargar el plugin: {e}"))?;
        if let Some(st) = state {
            let _ = plugin.load_state(st);
        }
        plugin.start_processing().map_err(|e| format!("No se pudo arrancar el plugin: {e}"))?;
        let pi = plugin.info().clone();
        let instrument = pi.category.to_lowercase().contains("instrument") || pi.audio_inputs == 0;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let plugin = Arc::new(Mutex::new(plugin));
        let bypass = Arc::new(AtomicBool::new(bypass));
        let info = SlotInfo {
            id,
            name: pi.name,
            vendor: pi.vendor,
            category: pi.category,
            path: path.to_string(),
            has_editor: pi.has_gui,
            editor_open: false,
            bypass: bypass.load(Ordering::Relaxed),
            instrument,
        };
        self.chain
            .tracks
            .lock()
            .unwrap()
            .entry(track.to_string())
            .or_default()
            .push(Slot { id, instrument, plugin: plugin.clone(), bypass: bypass.clone() });
        self.entries.push(Entry { track: track.to_string(), info: info.clone(), plugin, bypass, window: None });
        Ok(info)
    }

    /// Toca las notas de una pista por su cadena de plugins sin tiempo real y devuelve el audio (WAV).
    /// Usa los mismos plugins que suenan en vivo: mientras dura, el audio en vivo se aparta.
    fn render(&mut self, track: &str, notes: &[NoteIn], duration: f64) -> Result<Vec<u8>, String> {
        let plugins: Vec<(Arc<Mutex<Plugin>>, Arc<AtomicBool>)> = {
            let tracks = self.chain.tracks.lock().unwrap();
            let slots = tracks.get(track).ok_or("La pista no tiene plugins")?;
            if !slots.first().is_some_and(|s| s.instrument) {
                return Err("La pista no tiene un instrumento".into());
            }
            slots.iter().map(|s| (s.plugin.clone(), s.bypass.clone())).collect()
        };
        // Se apaga sola al salir, también si un plugin hace panic a mitad
        struct ExportGuard<'a>(&'a AtomicBool);
        impl Drop for ExportGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        self.chain.exporting.store(true, Ordering::SeqCst);
        let _guard = ExportGuard(&self.chain.exporting);
        // Dar tiempo a que el callback en vuelo termine antes de tocar los plugins
        thread::sleep(Duration::from_millis(50));
        let result = (|| {
            let mut guards: Vec<std::sync::MutexGuard<'_, Plugin>> =
                plugins.iter().map(|(p, _)| p.lock().unwrap_or_else(|e| e.into_inner())).collect();
            let rate = guards[0].sample_rate();
            let _ = guards[0].midi_panic();
            let events = build_events(notes);
            const BLOCK: usize = 512;
            let total = ((duration + 2.0) * rate) as usize;
            let mut bufs = AudioBuffers::new(2, 2, BLOCK, rate);
            let (mut left, mut right) = (Vec::with_capacity(total), Vec::with_capacity(total));
            let mut next = 0usize;
            let mut at = 0usize;
            let mut blocks = 0usize;
            while at < total {
                // Las ventanas de los plugins no se quedan congeladas durante una exportación larga
                blocks += 1;
                if blocks % 32 == 0 {
                    pump_os_messages();
                }
                let n = BLOCK.min(total - at);
                let (t0, t1) = (at as f64 / rate, (at + n) as f64 / rate);
                while next < events.len() && events[next].t < t1 {
                    let e = events[next];
                    next += 1;
                    let channel = vst3_host::MidiChannel::from_index(e.ch).unwrap_or(vst3_host::MidiChannel::Ch1);
                    let ev = if e.on {
                        MidiEvent::NoteOn { channel, note: e.note, velocity: e.vel }
                    } else {
                        MidiEvent::NoteOff { channel, note: e.note, velocity: 0 }
                    };
                    let offset = (((e.t - t0).max(0.0) * rate) as i32).clamp(0, n as i32 - 1);
                    let _ = guards[0].send_midi_event_at(ev, offset);
                }
                for c in 0..2 {
                    bufs.inputs[c].clear();
                    bufs.inputs[c].resize(n, 0.0);
                }
                for (i, g) in guards.iter_mut().enumerate() {
                    if plugins[i].1.load(Ordering::Relaxed) {
                        continue;
                    }
                    for ch in bufs.outputs.iter_mut() {
                        ch.clear();
                        ch.resize(n, 0.0);
                    }
                    bufs.block_size = n;
                    if g.process_audio(&mut bufs).is_ok() {
                        std::mem::swap(&mut bufs.inputs, &mut bufs.outputs);
                    }
                }
                left.extend_from_slice(&bufs.inputs[0]);
                right.extend_from_slice(&bufs.inputs[1]);
                at += n;
            }
            let _ = guards[0].midi_panic();
            Ok(wav_f32(&left, &right, rate as u32))
        })();
        result
    }

    fn remove(&mut self, id: u32) {
        let Some(i) = self.entries.iter().position(|e| e.info.id == id) else { return };
        let mut e = self.entries.remove(i);
        {
            let mut tracks = self.chain.tracks.lock().unwrap();
            if let Some(list) = tracks.get_mut(&e.track) {
                list.retain(|s| s.id != id);
                if list.is_empty() {
                    tracks.remove(&e.track);
                }
            }
        }
        if let Some(w) = e.window.as_mut() {
            w.close();
        }
        drop(e.window.take());
        if let Ok(mut p) = e.plugin.lock() {
            let _ = p.stop_processing();
        }
    }

    fn move_slot(&mut self, id: u32, dir: i32) {
        let Some(e) = self.entries.iter().find(|e| e.info.id == id) else { return };
        let track = e.track.clone();
        // Posiciones (dentro de `entries`) de los plugins de esa pista, en orden
        let idx: Vec<usize> = self.entries.iter().enumerate().filter(|(_, e)| e.track == track).map(|(i, _)| i).collect();
        let Some(pos) = idx.iter().position(|&i| self.entries[i].info.id == id) else { return };
        let to = (pos as i32 + dir).clamp(0, idx.len() as i32 - 1) as usize;
        if to == pos {
            return;
        }
        self.entries.swap(idx[pos], idx[to]);
        if let Some(list) = self.chain.tracks.lock().unwrap().get_mut(&track) {
            list.swap(pos, to);
        }
    }

    fn set_editor(&mut self, id: u32, open: bool) -> Result<(), String> {
        let e = self.entries.iter_mut().find(|e| e.info.id == id).ok_or("El plugin ya no está en la cadena")?;
        if open {
            if e.window.as_ref().is_some_and(|w| w.is_open()) {
                return Ok(());
            }
            let mut w = PluginWindow::new(e.plugin.clone());
            w.open().map_err(|e| format!("No se pudo abrir la ventana del plugin: {e}"))?;
            e.window = Some(w);
            e.info.editor_open = true;
        } else if let Some(mut w) = e.window.take() {
            w.close();
            e.info.editor_open = false;
        }
        Ok(())
    }
}

impl Entry {
    fn snapshot(&self) -> SlotInfo {
        let mut i = self.info.clone();
        i.bypass = self.bypass.load(Ordering::Relaxed);
        i
    }
}

fn scan() -> Result<Vec<Available>, String> {
    let host = Vst3Host::builder().scan_default_paths().build().map_err(|e| e.to_string())?;
    let mut out: Vec<Available> = host
        .scan_plugin_paths()
        .into_iter()
        // Un .vst3 es una carpeta con el binario dentro (Contents\x86_64-win\X.vst3): ese no cuenta aparte
        .filter(|p| !p.components().any(|c| c.as_os_str().eq_ignore_ascii_case("Contents")))
        .map(|p| Available {
            name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

// --- Comandos de Tauri ---------------------------------------------------------------------

#[tauri::command(async)]
pub fn plugin_scan(host: tauri::State<'_, PluginHost>) -> Result<Vec<Available>, String> {
    host.call(Cmd::Scan)
}

#[tauri::command(async)]
pub fn plugin_list(host: tauri::State<'_, PluginHost>, track: String) -> Result<Vec<SlotInfo>, String> {
    host.call(|r| Cmd::List(track, r))
}

#[tauri::command(async)]
pub fn plugin_load(host: tauri::State<'_, PluginHost>, track: String, path: String) -> Result<SlotInfo, String> {
    host.call(|r| Cmd::Load(track, path, r))
}

#[tauri::command(async)]
pub fn plugin_remove(host: tauri::State<'_, PluginHost>, id: u32) -> Result<(), String> {
    host.call(|r| Cmd::Remove(id, r))
}

#[tauri::command(async)]
pub fn plugin_editor(host: tauri::State<'_, PluginHost>, id: u32, open: bool) -> Result<(), String> {
    host.call(|r| Cmd::Editor(id, open, r))
}

#[tauri::command(async)]
pub fn plugin_move(host: tauri::State<'_, PluginHost>, id: u32, dir: i32) -> Result<(), String> {
    host.call(|r| Cmd::Move(id, dir, r))
}

#[tauri::command(async)]
pub fn plugin_bypass(host: tauri::State<'_, PluginHost>, id: u32, on: bool) -> Result<(), String> {
    host.call(|r| Cmd::Bypass(id, on, r))
}

/// Quita los plugins de las pistas que ya no existen.
#[tauri::command(async)]
pub fn plugin_prune(host: tauri::State<'_, PluginHost>, keep: Vec<String>) -> Result<(), String> {
    host.call(|r| Cmd::Prune(keep, r))
}

/// Todas las cadenas con su estado, para guardarlas en el proyecto.
#[tauri::command(async)]
pub fn plugin_snapshot(host: tauri::State<'_, PluginHost>) -> Result<HashMap<String, Vec<Saved>>, String> {
    host.call(Cmd::Snapshot)
}

/// Sustituye todas las cadenas por las de un proyecto. Devuelve los que no se pudieron cargar.
#[tauri::command(async)]
pub fn plugin_restore(host: tauri::State<'_, PluginHost>, chains: HashMap<String, Vec<Saved>>) -> Result<Vec<String>, String> {
    host.call(|r| Cmd::Restore(chains, r))
}

/// Plugins (con su estado) de una pista, para guardarlos en una plantilla.
#[tauri::command(async)]
pub fn plugin_snapshot_track(host: tauri::State<'_, PluginHost>, track: String) -> Result<Vec<Saved>, String> {
    host.call(|r| Cmd::SnapshotTrack(track, r))
}

/// Carga en una pista los plugins de una plantilla. Devuelve los que no se pudieron cargar.
#[tauri::command(async)]
pub fn plugin_apply(host: tauri::State<'_, PluginHost>, track: String, plugins: Vec<Saved>) -> Result<Vec<String>, String> {
    host.call(|r| Cmd::Apply(track, plugins, r))
}

/// Pistas armadas: sus instrumentos suenan al tocarlos con el controlador MIDI.
#[tauri::command(async)]
pub fn plugin_set_armed(host: tauri::State<'_, PluginHost>, tracks: Vec<String>) {
    host.chain.set_armed(tracks);
}

/// Pistas que se están escuchando ahora (solo suenan las cadenas de estas).
#[tauri::command(async)]
pub fn plugin_set_monitored(host: tauri::State<'_, PluginHost>, tracks: Vec<String>) {
    *host.chain.monitored.lock().unwrap() = tracks;
}

// --- Secuenciador (clips MIDI) -------------------------------------------------------------

/// Notas de los clips MIDI de cada pista, con tiempos absolutos.
#[tauri::command(async)]
pub fn midi_set_clips(host: tauri::State<'_, PluginHost>, clips: HashMap<String, Vec<NoteIn>>) {
    host.chain.set_clips(clips);
}

/// Volumen y audibilidad (mute/solo) de cada pista, para los instrumentos que suenan con la canción.
#[tauri::command(async)]
pub fn midi_set_mix(host: tauri::State<'_, PluginHost>, mix: HashMap<String, (f32, bool)>) {
    host.chain.set_mix(mix);
}

/// Ajuste de sincronía (ms) entre los instrumentos y el audio de las pistas.
#[tauri::command(async)]
pub fn midi_set_offset(host: tauri::State<'_, PluginHost>, ms: f64) {
    host.chain.set_offset(ms / 1000.0);
}

/// La canción empieza o salta a `position` s, dentro de `delay` s.
#[tauri::command(async)]
pub fn midi_play(host: tauri::State<'_, PluginHost>, position: f64, delay: f64) {
    host.chain.play(position, delay);
}

#[tauri::command(async)]
pub fn midi_stop(host: tauri::State<'_, PluginHost>) {
    host.chain.stop();
}

/// Renderiza sin tiempo real los instrumentos de una pista a un WAV (para exportar la mezcla).
/// `clips` son las notas con tiempos absolutos; `duration`, hasta dónde dura la canción.
#[tauri::command(async)]
pub fn plugin_render(
    host: tauri::State<'_, PluginHost>,
    track: String,
    clips: Vec<NoteIn>,
    duration: f64,
) -> Result<tauri::ipc::Response, String> {
    host.call_for(Duration::from_secs(900), |r| Cmd::Render(track, clips, duration, r)).map(tauri::ipc::Response::new)
}

/// Entrada de cada pista (0 = entrada 1, 1 = entrada 2, 2 = las dos en estéreo).
#[tauri::command(async)]
pub fn plugin_set_inputs(host: tauri::State<'_, PluginHost>, inputs: HashMap<String, u8>) {
    host.chain.set_inputs(inputs);
}

/// Resumen de las cadenas: por pista, nº de plugins y si el primero es un instrumento (pista de MIDI).
#[tauri::command(async)]
pub fn plugin_overview(host: tauri::State<'_, PluginHost>) -> HashMap<String, (usize, bool)> {
    host.chain.overview()
}

/// Dispositivo MIDI de cada pista ("" = cualquiera).
#[tauri::command(async)]
pub fn plugin_set_midi_ports(host: tauri::State<'_, PluginHost>, ports: HashMap<String, String>) {
    host.chain.set_midi_ports(ports);
}

#[derive(Deserialize)]
pub struct RecReq {
    track: String,
    /// Con los efectos de la pista; si no, la señal limpia de su entrada.
    wet: bool,
}

/// Empieza a grabar audio desde el motor nativo (la señal de cada pista, limpia o con efectos).
/// Devuelve las pistas grabadas y cómo (una pista sin plugins de efectos se graba limpia).
#[tauri::command(async)]
pub fn audio_record_start(host: tauri::State<'_, PluginHost>, tracks: Vec<RecReq>) -> Vec<(String, bool)> {
    if tracks.is_empty() {
        return Vec::new();
    }
    let reqs: Vec<(String, bool)> = tracks.into_iter().map(|r| (r.track, r.wet)).collect();
    host.chain.start_audio_rec(&reqs)
}

/// Termina la toma de audio nativa. Respuesta binaria: u32 nº de pistas y, por cada una,
/// u32 largo del id + id + f64 desfase + u32 frecuencia + u32 nº de frames + f32 intercalados (L, R).
#[tauri::command(async)]
pub fn audio_record_stop(host: tauri::State<'_, PluginHost>) -> tauri::ipc::Response {
    let takes = host.chain.stop_audio_rec();
    let mut out = Vec::new();
    out.extend_from_slice(&(takes.len() as u32).to_le_bytes());
    for (track, offset, rate, data) in takes {
        out.extend_from_slice(&(track.len() as u32).to_le_bytes());
        out.extend_from_slice(track.as_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&((data.len() / 2) as u32).to_le_bytes());
        for x in data {
            out.extend_from_slice(&x.to_le_bytes());
        }
    }
    tauri::ipc::Response::new(out)
}
