//! Motor de audio nativo (cpal: ASIO o WASAPI en Windows).
//!
//! Primer hito: monitorización de la entrada en tiempo real.
//!
//!   callback de entrada ──(cola sin bloqueos)──▶ callback de salida
//!
//! Los callbacks corren en el hilo de audio del driver: nada de bloqueos ni
//! reservas de memoria ahí. La UI se comunica con atómicos (`Shared`) y lee
//! los niveles con `audio_meter`.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig, SupportedBufferSize};
use rtrb::RingBuffer;
use serde::{Deserialize, Serialize};

// --- Estado compartido con los callbacks ---------------------------------------

/// f32 guardado en un AtomicU32 (para valores >= 0 el orden de los bits es el numérico).
struct AtomicF32(AtomicU32);

impl AtomicF32 {
    fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed)
    }
    /// Solo para valores >= 0.
    fn fetch_max(&self, v: f32) {
        self.0.fetch_max(v.to_bits(), Ordering::Relaxed);
    }
    fn take(&self) -> f32 {
        f32::from_bits(self.0.swap(0, Ordering::Relaxed))
    }
}

/// Qué entrada del dispositivo se usa: 0 = entrada 1, 1 = entrada 2, 2 = las dos (estéreo).
const STEREO: u8 = 2;

struct Shared {
    /// Plugins VST3 insertados entre la entrada y la salida.
    chain: Arc<crate::plugins::Chain>,
    monitor: AtomicBool,
    gain: AtomicF32,
    input_channel: AtomicU8,
    /// Picos (desde la última lectura) de las dos primeras entradas en bruto.
    peaks: [AtomicF32; 2],
    /// Veces que faltó o sobró audio entre entrada y salida (cortes).
    xruns: AtomicU32,
    /// Frames que entrega el último callback de entrada (para dimensionar la cola).
    in_block: AtomicU32,
    /// Latencias medidas por el driver en cada callback (ms).
    input_latency: AtomicF32,
    output_latency: AtomicF32,
}

// --- Tipos que se pasan a la UI -----------------------------------------------

#[derive(Serialize)]
pub struct HostInfo {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    id: String,
    name: String,
    inputs: u16,
    outputs: u16,
    sample_rate: Option<u32>,
    /// Tamaños de búfer admitidos (min, max), si el driver lo informa.
    buffer_range: Option<(u32, u32)>,
    is_default_input: bool,
    is_default_output: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConfig {
    host: String,
    /// Sistema de audio de la salida; None = el mismo que la entrada.
    output_host: Option<String>,
    input_device: String,
    output_device: String,
    buffer_size: Option<u32>,
    input_channel: u8,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    host: String,
    output_host: String,
    input_name: String,
    output_name: String,
    sample_rate: u32,
    /// Búfer real (frames) o None si el driver no lo dice.
    buffer_size: Option<u32>,
    input_channels: u16,
    output_channels: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    peaks: [f32; 2],
    xruns: u32,
    /// Latencia de ida y vuelta medida (ms): entrada + cola + salida.
    input_latency_ms: f32,
    output_latency_ms: f32,
}

// --- Motor -------------------------------------------------------------------------
//
// Todo lo que toca cpal/ASIO corre en un hilo propio (`audio_thread`):
// - Los drivers ASIO son objetos COM ligados al hilo que los abre.
// - Si un driver se queda colgado, solo se cuelga ese hilo: la ventana sigue
//   respondiendo y el comando devuelve un error al pasar el tiempo límite.
// - Ese hilo se abandona y se crea otro, así se puede cambiar de driver sin
//   reiniciar la app. Si el abandonado acaba despertando, ve que ya no es el
//   actual (`generation`), suelta lo que haya abierto y termina.

/// ASIO4ALL tarda hasta ~15 s en abrir si otro programa tiene la interfaz.
const START_TIMEOUT: Duration = Duration::from_secs(45);
const TIMEOUT: Duration = Duration::from_secs(30);

type Reply<T> = mpsc::Sender<Result<T, String>>;

enum Cmd {
    Hosts(Reply<Vec<HostInfo>>),
    Devices(String, Reply<Vec<DeviceInfo>>),
    Start(StartConfig, Reply<EngineInfo>),
    Stop(Reply<()>),
}

struct Running {
    _input: Stream,
    _output: Stream,
}

pub struct Engine {
    shared: Arc<Shared>,
    info: Arc<Mutex<Option<EngineInfo>>>,
    generation: Arc<AtomicU32>,
    tx: Mutex<mpsc::Sender<Cmd>>,
}

impl Default for Engine {
    fn default() -> Self {
        let shared = Arc::new(Shared {
            chain: Arc::new(crate::plugins::Chain::default()),
            monitor: AtomicBool::new(false),
            gain: AtomicF32::new(1.0),
            input_channel: AtomicU8::new(0),
            peaks: [AtomicF32::new(0.0), AtomicF32::new(0.0)],
            xruns: AtomicU32::new(0),
            in_block: AtomicU32::new(0),
            input_latency: AtomicF32::new(0.0),
            output_latency: AtomicF32::new(0.0),
        });
        let info = Arc::new(Mutex::new(None));
        let generation = Arc::new(AtomicU32::new(0));
        let tx = Mutex::new(spawn_audio_thread(&shared, &info, &generation, 0));
        Self { shared, info, generation, tx }
    }
}

fn spawn_audio_thread(
    shared: &Arc<Shared>,
    info: &Arc<Mutex<Option<EngineInfo>>>,
    generation: &Arc<AtomicU32>,
    id: u32,
) -> mpsc::Sender<Cmd> {
    let (tx, rx) = mpsc::channel();
    let (s, i, g) = (shared.clone(), info.clone(), generation.clone());
    thread::Builder::new()
        .name(format!("riff-audio-{id}"))
        .spawn(move || audio_thread(s, i, rx, g, id))
        .expect("no se pudo crear el hilo de audio");
    tx
}

impl Engine {
    pub fn chain(&self) -> Arc<crate::plugins::Chain> {
        self.shared.chain.clone()
    }

    /// Manda una orden al hilo de audio y espera la respuesta (como mucho `timeout`).
    fn call<T>(&self, timeout: Duration, make: impl FnOnce(Reply<T>) -> Cmd) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .lock()
            .unwrap()
            .send(make(tx))
            .map_err(|_| "El motor de audio se ha detenido".to_string())?;
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                // El hilo se ha quedado atrapado en el driver: abandonarlo y empezar con otro
                let id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
                log(format!("el driver no responde: se abandona el hilo y se crea el {id}"));
                *self.info.lock().unwrap() = None;
                self.shared.monitor.store(false, Ordering::Relaxed);
                *self.tx.lock().unwrap() = spawn_audio_thread(&self.shared, &self.info, &self.generation, id);
                Err("El driver de audio no responde (tarda demasiado en abrir). Prueba con WASAPI, o cierra los \
                     otros programas que usen la interfaz."
                    .into())
            }
        }
    }
}

impl Engine {
    /// Cierra los streams (y con ellos el driver) antes de salir de la app. Si el driver sigue
    /// abierto al terminar el proceso, ASIO4ALL puede dejarlo colgado sin ventana.
    pub fn shutdown(&self) {
        log("cerrando la app: parando el motor…");
        let _ = self.call(Duration::from_secs(3), Cmd::Stop);
        // Último recurso: si aun así la salida normal se atasca, terminar a la fuerza
        thread::spawn(|| {
            thread::sleep(Duration::from_secs(3));
            log("la salida se ha atascado: se termina a la fuerza");
            std::process::abort();
        });
    }
}

/// Traza para diagnosticar drivers (va al archivo de registro).
fn log(msg: impl std::fmt::Display) {
    crate::logfile::write(format!("[audio] {msg}"));
}

fn audio_thread(
    shared: Arc<Shared>,
    info: Arc<Mutex<Option<EngineInfo>>>,
    rx: mpsc::Receiver<Cmd>,
    generation: Arc<AtomicU32>,
    id: u32,
) {
    let current = || generation.load(Ordering::SeqCst) == id;
    let mut running: Option<Running> = None;
    for cmd in rx {
        match cmd {
            Cmd::Hosts(r) => {
                log("listar sistemas…");
                let _ = r.send(Ok(list_hosts()));
                log("listar sistemas: ok");
            }
            Cmd::Devices(host, r) => {
                log(format!("listar dispositivos de {host}…"));
                let res = list_devices(&host);
                log(format!(
                    "listar dispositivos: {:?}",
                    res.as_ref().map(|d| d.iter().map(|d| (&d.name, d.inputs, d.outputs)).collect::<Vec<_>>())
                ));
                let _ = r.send(res);
            }
            Cmd::Start(config, r) => {
                log(format!("arrancar {} (búfer {:?})…", config.host, config.buffer_size));
                // Un driver ASIO solo se puede abrir una vez: cerrar lo anterior primero
                if running.take().is_some() {
                    log("cerrado el anterior");
                }
                *info.lock().unwrap() = None;
                let result = start(&shared, &config);
                if !current() {
                    log("el hilo abandonado ha despertado: suelta el driver y termina");
                    return;
                }
                let result = result.map(|(run, i)| {
                    running = Some(run);
                    *info.lock().unwrap() = Some(i.clone());
                    i
                });
                match &result {
                    Ok(_) => log("arrancar: ok"),
                    Err(e) => log(format!("arrancar: error: {e}")),
                }
                let _ = r.send(result);
            }
            Cmd::Stop(r) => {
                log("parar…");
                running = None;
                log("parar: ok");
                *info.lock().unwrap() = None;
                shared.monitor.store(false, Ordering::Relaxed);
                shared.peaks[0].store(0.0);
                shared.peaks[1].store(0.0);
                let _ = r.send(Ok(()));
            }
        }
        if !current() {
            log("hilo abandonado: termina");
            return;
        }
    }
}

fn host_by_name(name: &str) -> Result<cpal::Host, String> {
    let id = cpal::available_hosts()
        .into_iter()
        .find(|h| h.name().eq_ignore_ascii_case(name))
        .ok_or_else(|| format!("El sistema de audio «{name}» no está disponible"))?;
    cpal::host_from_id(id).map_err(|e| e.to_string())
}

fn device_name(d: &Device) -> String {
    d.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "Dispositivo".into())
}

fn find_device(host: &cpal::Host, id: &str) -> Result<Device, String> {
    let parsed = id.parse().map_err(|e: cpal::Error| e.to_string())?;
    if let Some(d) = host.device_by_id(&parsed) {
        return Ok(d);
    }
    #[cfg(windows)]
    if let Some((_, name)) = id.split_once(':').filter(|_| host.id().name().eq_ignore_ascii_case("ASIO")) {
        return Err(asio_failure(name));
    }
    Err("No se encuentra el dispositivo (¿desconectado?)".to_string())
}

fn range(b: &SupportedBufferSize) -> Option<(u32, u32)> {
    match b {
        SupportedBufferSize::Range { min, max } => Some((*min, *max)),
        _ => None,
    }
}

fn list_hosts() -> Vec<HostInfo> {
    cpal::available_hosts()
        .into_iter()
        .map(|h| HostInfo { id: h.name().to_string(), name: h.name().to_string() })
        .collect()
}

/// Los drivers ASIO instalados, solo por nombre. cpal carga cada driver para listarlos (también los
/// de equipos desconectados, y ASIO4ALL tarda 10-20 s): aquí se lee la lista y se abre de verdad
/// solo el elegido, al arrancar.
#[cfg(windows)]
fn asio_devices() -> Vec<DeviceInfo> {
    asio_sys::Asio::new()
        .driver_names()
        .into_iter()
        .map(|name| DeviceInfo {
            id: cpal::DeviceId::new(cpal::HostId::Asio, &name).to_string(),
            name,
            inputs: 0,
            outputs: 0,
            sample_rate: None,
            buffer_range: None,
            is_default_input: false,
            is_default_output: false,
        })
        .collect()
}

/// Por qué no se puede abrir un driver ASIO que está instalado.
#[cfg(windows)]
fn asio_failure(name: &str) -> String {
    let reason = match asio_sys::Asio::new().load_driver(name) {
        Ok(_) => return format!("El driver «{name}» ha respondido tarde. Pulsa Reintentar."),
        Err(e) => format!("{e:?}"),
    };
    log(format!("el driver ASIO «{name}» no carga: {reason}"));
    if reason.contains("NoDrivers") || reason.contains("HardwareMalfunction") {
        format!("«{name}» no encuentra su equipo. Comprueba que la interfaz está conectada y libre (sin otro programa usándola), o elige otro driver.")
    } else if reason.contains("DriverAlreadyExists") {
        "Hay otro driver ASIO abierto en Riff Studio. Apaga el motor, vuelve a encenderlo y prueba de nuevo.".into()
    } else {
        format!("No se pudo abrir «{name}». Puede que otro programa esté usando la interfaz: ciérralo y pulsa Reintentar. ({reason})")
    }
}

fn list_devices(host: &str) -> Result<Vec<DeviceInfo>, String> {
    #[cfg(windows)]
    if host.eq_ignore_ascii_case("ASIO") {
        return Ok(asio_devices());
    }
    let host = host_by_name(host)?;
    let default_in = host.default_input_device().and_then(|d| d.id().ok());
    let default_out = host.default_output_device().and_then(|d| d.id().ok());
    let devices = host.devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in devices {
        let Ok(id) = d.id() else { continue };
        let inp = d.default_input_config();
        let outp = d.default_output_config();
        // Un driver que no deja leer su configuración (p. ej. ASIO4ALL ocupado) se lista
        // igualmente, para que se vea y el error real salga al intentar arrancarlo.
        if let (Err(ei), Err(eo)) = (&inp, &outp) {
            log(format!("  «{}»: sin configuración (entrada: {ei}; salida: {eo})", device_name(&d)));
        }
        let (inp, outp) = (inp.ok(), outp.ok());
        let any = outp.as_ref().or(inp.as_ref());
        out.push(DeviceInfo {
            id: id.to_string(),
            name: device_name(&d),
            inputs: inp.as_ref().map_or(0, |c| c.channels()),
            outputs: outp.as_ref().map_or(0, |c| c.channels()),
            sample_rate: any.map(|c| c.sample_rate()),
            buffer_range: any.and_then(|c| range(c.buffer_size())),
            is_default_input: default_in.as_ref() == Some(&id),
            is_default_output: default_out.as_ref() == Some(&id),
        });
    }
    Ok(out)
}

fn start(shared: &Arc<Shared>, config: &StartConfig) -> Result<(Running, EngineInfo), String> {
    let in_host = host_by_name(&config.host)?;
    let out_host = match config.output_host.as_deref() {
        Some(h) if !h.eq_ignore_ascii_case(&config.host) => host_by_name(h)?,
        _ => host_by_name(&config.host)?,
    };
    let input = find_device(&in_host, &config.input_device)?;
    let output = find_device(&out_host, &config.output_device)?;
    let in_cfg = input.default_input_config().map_err(|e| format!("Entrada: {e}"))?;
    let out_cfg = output.default_output_config().map_err(|e| format!("Salida: {e}"))?;
    log(format!("  entrada «{}» {in_cfg:?}", device_name(&input)));
    log(format!("  salida «{}» {out_cfg:?}", device_name(&output)));

    // Entrada y salida van por relojes distintos si son dispositivos o sistemas distintos
    // (p. ej. interfaz por ASIO y parlantes por WASAPI): hay que remuestrear y corregir la deriva.
    let in_rate = in_cfg.sample_rate();
    let out_rate = out_cfg.sample_rate();
    let cross = in_host.id() != out_host.id() || config.input_device != config.output_device || in_rate != out_rate;

    let requested = config.buffer_size.map_or(BufferSize::Default, BufferSize::Fixed);
    let in_stream_cfg = StreamConfig { channels: in_cfg.channels(), sample_rate: in_rate, buffer_size: requested };
    // La salida usa el búfer pedido solo si su driver lo admite; si no, el suyo
    let out_buffer = match (config.buffer_size, range(out_cfg.buffer_size())) {
        (Some(n), Some((lo, hi))) if n >= lo && n <= hi => BufferSize::Fixed(n),
        (Some(_), Some(_)) => BufferSize::Default,
        (Some(n), None) if !cross => BufferSize::Fixed(n),
        _ => BufferSize::Default,
    };
    let out_stream_cfg = StreamConfig { channels: out_cfg.channels(), sample_rate: out_rate, buffer_size: out_buffer };

    shared.input_channel.store(config.input_channel.min(STEREO), Ordering::Relaxed);
    shared.xruns.store(0, Ordering::Relaxed);
    shared.in_block.store(0, Ordering::Relaxed);
    log("  ajustando los plugins…");
    shared.chain.prepare(in_rate as f64);
    log("  plugins listos");

    // Cola de ~100 ms en frames estéreo; en la práctica solo lleva un búfer o dos
    let capacity = (in_rate as usize / 10).max(4096) * 2;
    let (producer, consumer) = RingBuffer::<f32>::new(capacity);
    let ratio = in_rate as f64 / out_rate as f64;

    // Primero la salida: abrir la entrada antes hace que ASIO pida un reinicio del driver
    let output_stream =
        build_output(&output, &out_stream_cfg, out_cfg.sample_format(), shared.clone(), consumer, cross.then_some(ratio))?;
    log("  salida creada");
    let input_stream = build_input(&input, &in_stream_cfg, in_cfg.sample_format(), shared.clone(), producer)?;
    log("  entrada creada");
    input_stream.play().map_err(|e| format!("No se pudo arrancar la entrada: {e}"))?;
    log("  entrada sonando");
    output_stream.play().map_err(|e| format!("No se pudo arrancar la salida: {e}"))?;
    log("  salida sonando");

    let info = EngineInfo {
        host: in_host.id().name().to_string(),
        output_host: out_host.id().name().to_string(),
        input_name: device_name(&input),
        output_name: device_name(&output),
        sample_rate: out_rate,
        buffer_size: output_stream.buffer_size().ok(),
        input_channels: in_cfg.channels(),
        output_channels: out_cfg.channels(),
    };
    Ok((Running { _input: input_stream, _output: output_stream }, info))
}

// --- Comandos de Tauri ---------------------------------------------------------------
// Los que hablan con el driver son `async`: así no corren en el hilo principal
// (el de la ventana) y esperar al hilo de audio no congela la interfaz.

#[tauri::command(async)]
pub fn audio_hosts(engine: tauri::State<'_, Engine>) -> Result<Vec<HostInfo>, String> {
    engine.call(TIMEOUT, Cmd::Hosts)
}

#[tauri::command(async)]
pub fn audio_devices(engine: tauri::State<'_, Engine>, host: String) -> Result<Vec<DeviceInfo>, String> {
    engine.call(TIMEOUT, |r| Cmd::Devices(host, r))
}

#[tauri::command(async)]
pub fn audio_start(engine: tauri::State<'_, Engine>, config: StartConfig) -> Result<EngineInfo, String> {
    engine.call(START_TIMEOUT, |r| Cmd::Start(config, r))
}

#[tauri::command(async)]
pub fn audio_stop(engine: tauri::State<'_, Engine>) -> Result<(), String> {
    engine.call(TIMEOUT, Cmd::Stop)
}

#[tauri::command]
pub fn audio_info(engine: tauri::State<'_, Engine>) -> Option<EngineInfo> {
    engine.info.lock().unwrap().clone()
}

#[tauri::command]
pub fn audio_set_monitor(engine: tauri::State<'_, Engine>, on: bool, gain: Option<f32>) {
    engine.shared.monitor.store(on, Ordering::Relaxed);
    if let Some(g) = gain {
        engine.shared.gain.store(g.clamp(0.0, 4.0));
    }
}

#[tauri::command]
pub fn audio_set_input_channel(engine: tauri::State<'_, Engine>, channel: u8) {
    engine.shared.input_channel.store(channel.min(STEREO), Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_meter(engine: tauri::State<'_, Engine>) -> Meter {
    let s = &engine.shared;
    Meter {
        peaks: [s.peaks[0].take(), s.peaks[1].take()],
        xruns: s.xruns.load(Ordering::Relaxed),
        input_latency_ms: s.input_latency.load(),
        output_latency_ms: s.output_latency.load(),
    }
}

// --- Callbacks ---------------------------------------------------------------------

fn ms(d: std::time::Duration) -> f32 {
    d.as_secs_f32() * 1000.0
}

fn build_input(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    shared: Arc<Shared>,
    producer: rtrb::Producer<f32>,
) -> Result<Stream, String> {
    macro_rules! build {
        ($t:ty) => {
            input_stream::<$t>(device, config, shared, producer)
        };
    }
    match format {
        SampleFormat::F32 => build!(f32),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I32 => build!(i32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::U16 => build!(u16),
        other => Err(format!("Formato de entrada no soportado: {other}")),
    }
}

fn input_stream<T>(device: &Device, config: &StreamConfig, shared: Arc<Shared>, mut producer: rtrb::Producer<f32>) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    // Buffers para los plugins (se reservan una vez; en el callback no se pide memoria)
    let mut bufs = vst3_host::AudioBuffers::new(2, 2, 0, config.sample_rate as f64);
    for ch in bufs.inputs.iter_mut().chain(bufs.outputs.iter_mut()) {
        ch.reserve(8192);
    }
    let mut scratch = crate::plugins::Scratch::new();
    device
        .build_input_stream::<T, _, _>(
            config.clone(),
            move |data: &[T], info: &cpal::InputCallbackInfo| {
                let ts = info.timestamp();
                shared.input_latency.store(ms(ts.callback.duration_since(ts.capture)));
                let n = data.len() / channels;
                shared.in_block.store(n as u32, Ordering::Relaxed);
                let sel = shared.input_channel.load(Ordering::Relaxed);
                let mut p = [0f32; 2];
                bufs.inputs[0].clear();
                bufs.inputs[1].clear();
                for frame in data.chunks_exact(channels) {
                    let a = f32::from_sample(frame[0]);
                    let b = if channels > 1 { f32::from_sample(frame[1]) } else { a };
                    p[0] = p[0].max(a.abs());
                    p[1] = p[1].max(b.abs());
                    // Una entrada sola (guitarra) suena en los dos lados; estéreo tal cual
                    let (l, r) = match sel {
                        0 => (a, a),
                        1 => (b, b),
                        _ => (a, b),
                    };
                    bufs.inputs[0].push(l);
                    bufs.inputs[1].push(r);
                }
                shared.peaks[0].fetch_max(p[0]);
                shared.peaks[1].fetch_max(p[1]);

                // Cada pista que se escucha toma la entrada que tiene elegida y pasa por sus plugins
                // (si no se escucha nada, nadie oye el resultado)
                if shared.monitor.load(Ordering::Relaxed) || shared.chain.is_playing() || shared.chain.is_recording() || shared.chain.has_armed() {
                    for c in 0..2 {
                        scratch.raw[c].clear();
                    }
                    for frame in data.chunks_exact(channels) {
                        let a = f32::from_sample(frame[0]);
                        let b = if channels > 1 { f32::from_sample(frame[1]) } else { a };
                        scratch.raw[0].push(a);
                        scratch.raw[1].push(b);
                    }
                    scratch.latency = (shared.input_latency.load() / 1000.0) as f64;
                    shared.chain.process(&mut bufs, &mut scratch);
                }

                for (l, r) in bufs.inputs[0].iter().zip(&bufs.inputs[1]) {
                    if producer.slots() >= 2 {
                        let _ = producer.push(*l);
                        let _ = producer.push(*r);
                    }
                }
            },
            |err| log(format!("error de entrada: {err}")),
            None,
        )
        .map_err(|e| format!("No se pudo abrir la entrada: {e}"))
}

fn build_output(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    shared: Arc<Shared>,
    consumer: rtrb::Consumer<f32>,
    resample: Option<f64>,
) -> Result<Stream, String> {
    macro_rules! build {
        ($t:ty) => {
            output_stream::<$t>(device, config, shared, consumer, resample)
        };
    }
    match format {
        SampleFormat::F32 => build!(f32),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I32 => build!(i32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::U16 => build!(u16),
        other => Err(format!("Formato de salida no soportado: {other}")),
    }
}

/// Estado del remuestreador lineal con corrección de deriva (solo si entrada y salida
/// no comparten reloj): lleva la cola de la entrada hacia un nivel objetivo ajustando
/// un poco la velocidad de lectura.
struct Resampler {
    ratio: f64,
    frac: f64,
    prev: (f32, f32),
    next: (f32, f32),
    avg: f32,
}

fn pop_frame(c: &mut rtrb::Consumer<f32>, starved: &mut bool) -> (f32, f32) {
    match (c.pop(), c.pop()) {
        (Ok(l), Ok(r)) => (l, r),
        _ => {
            *starved = true;
            (0.0, 0.0)
        }
    }
}

fn output_stream<T>(
    device: &Device,
    config: &StreamConfig,
    shared: Arc<Shared>,
    mut consumer: rtrb::Consumer<f32>,
    resample: Option<f64>,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let mut rs = resample.map(|ratio| Resampler { ratio, frac: 1.0, prev: (0.0, 0.0), next: (0.0, 0.0), avg: 0.0 });
    device
        .build_output_stream::<T, _, _>(
            config.clone(),
            move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
                let ts = info.timestamp();
                shared.output_latency.store(ms(ts.playback.duration_since(ts.callback)));
                let frames = data.len() / channels;
                let monitor = shared.monitor.load(Ordering::Relaxed) || shared.chain.is_playing() || shared.chain.has_armed();
                let gain = shared.gain.load();
                let mut starved = false;

                let mut step = 1.0;
                if let Some(rs) = rs.as_mut() {
                    // Nivel objetivo de la cola (frames de entrada): un bloque de entrada y uno de salida
                    let queued = (consumer.slots() / 2) as f32;
                    let target = shared.in_block.load(Ordering::Relaxed) as f32 + frames as f32 * rs.ratio as f32;
                    rs.avg += (queued - rs.avg) * 0.05;
                    // Muy por encima del objetivo: tirar lo sobrante en vez de acumular retraso
                    if queued > target * 4.0 + 512.0 {
                        let drop = (((queued - target) as usize) * 2).min(consumer.slots() & !1);
                        if let Ok(chunk) = consumer.read_chunk(drop) {
                            chunk.commit_all();
                        }
                        rs.avg = target;
                        shared.xruns.fetch_add(1, Ordering::Relaxed);
                    }
                    let adj = (((rs.avg - target) as f64) * 1e-5).clamp(-0.005, 0.005);
                    step = rs.ratio * (1.0 + adj);
                } else {
                    // Mismo reloj: si se acumula audio, tirar lo sobrante (la latencia no crece de un búfer)
                    let queued = consumer.slots() / 2;
                    // (con margen para un bloque de entrada: tirar audio es un corte, suena como un "pop")
                    let in_block = shared.in_block.load(Ordering::Relaxed) as usize;
                    if queued > frames * 2 + in_block {
                        let drop = (queued - frames) * 2;
                        if let Ok(chunk) = consumer.read_chunk(drop) {
                            chunk.commit_all();
                        }
                        shared.xruns.fetch_add(1, Ordering::Relaxed);
                    }
                }

                for frame in data.chunks_exact_mut(channels) {
                    let (l, r) = match rs.as_mut() {
                        Some(rs) => {
                            while rs.frac >= 1.0 {
                                rs.prev = rs.next;
                                rs.next = pop_frame(&mut consumer, &mut starved);
                                rs.frac -= 1.0;
                            }
                            let t = rs.frac as f32;
                            rs.frac += step;
                            (rs.prev.0 + (rs.next.0 - rs.prev.0) * t, rs.prev.1 + (rs.next.1 - rs.prev.1) * t)
                        }
                        None => pop_frame(&mut consumer, &mut starved),
                    };
                    // Un amplificador saturado puede pasar de 0 dBFS: recortar aquí en vez de dejar que el driver lo haga a lo bruto
                    let (l, r) = if monitor { ((l * gain).clamp(-1.0, 1.0), (r * gain).clamp(-1.0, 1.0)) } else { (0.0, 0.0) };
                    frame[0] = T::from_sample(l);
                    if channels > 1 {
                        frame[1] = T::from_sample(r);
                    }
                    for s in frame.iter_mut().skip(2) {
                        *s = T::EQUILIBRIUM;
                    }
                }
                if starved && monitor {
                    shared.xruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            |err| log(format!("error de salida: {err}")),
            None,
        )
        .map_err(|e| format!("No se pudo abrir la salida: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Arranca el motor de verdad con los dispositivos predeterminados de WASAPI y comprueba
    /// que no se cuelga, que la entrada entrega bloques y que la salida los consume.
    #[test]
    fn arranca_y_circula_audio_por_wasapi() {
        let devices = match list_devices("WASAPI") {
            Ok(d) => d,
            Err(e) => {
                eprintln!("(sin WASAPI: {e})");
                return;
            }
        };
        let (Some(inp), Some(out)) = (
            devices.iter().find(|d| d.is_default_input),
            devices.iter().find(|d| d.is_default_output),
        ) else {
            eprintln!("(sin dispositivos predeterminados)");
            return;
        };
        let engine = Engine::default();
        let config = StartConfig {
            host: "WASAPI".into(),
            output_host: None,
            input_device: inp.id.clone(),
            output_device: out.id.clone(),
            buffer_size: None,
            input_channel: 0,
        };
        let t0 = std::time::Instant::now();
        let (run, info) = match start(&engine.shared, &config) {
            Ok(r) => r,
            // 0x8889000A: otro programa (p. ej. la propia app abierta) tiene el dispositivo
            Err(e) if e.contains("-2004287478") => {
                eprintln!("(dispositivo en uso por otro programa: prueba omitida)");
                return;
            }
            Err(e) => panic!("el motor no arranca: {e}"),
        };
        eprintln!("arrancó en {:.1?}: entrada «{}», salida «{}», {} Hz", t0.elapsed(), info.input_name, info.output_name, info.sample_rate);
        engine.shared.monitor.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(1500));
        let in_block = engine.shared.in_block.load(Ordering::Relaxed);
        let xruns = engine.shared.xruns.load(Ordering::Relaxed);
        eprintln!("bloque de entrada: {in_block} frames, cortes: {xruns}, latencia salida: {:.1} ms", engine.shared.output_latency.load());
        assert!(in_block > 0, "la entrada no entrega bloques");
        drop(run);
    }
}
