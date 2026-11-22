//! Entrada MIDI (la Maschine, teclados, pads…) hacia los instrumentos VST3.
//!
//!   puertos MIDI ──▶ evento (con su puerto) ──▶ instrumento de cada pista que se escucha
//!
//! Se pueden tener varios dispositivos conectados a la vez y cada pista elige de
//! cuál toma las notas (o de cualquiera). Windows deja abrir un puerto MIDI a una
//! sola aplicación: si el software de Native Instruments u otro programa lo tiene
//! abierto, aquí falla.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use midir::{MidiInput, MidiInputConnection};
use serde::Serialize;
use vst3_host::{MidiChannel, MidiEvent};

use crate::plugins::{Chain, PluginHost};

/// Toma en curso: notas recibidas con su tiempo (s) desde que empezó.
struct Rec {
    t0: Instant,
    /// (pista, puerto del que toma las notas; vacío = cualquiera)
    tracks: Vec<(String, String)>,
    /// (tiempo, encendida, canal, nota, velocidad, puerto)
    events: Vec<(f64, bool, u8, u8, u8, String)>,
}

#[derive(Serialize)]
pub struct NoteOut {
    start: f64,
    dur: f64,
    note: u8,
    vel: u8,
    ch: u8,
}

#[derive(Serialize)]
pub struct TrackNotes {
    track: String,
    notes: Vec<NoteOut>,
}

#[derive(Serialize)]
pub struct Recorded {
    tracks: Vec<TrackNotes>,
    /// Duración de la toma (s) desde que empezó.
    length: f64,
}

#[derive(Default)]
pub struct Midi {
    rec: Arc<Mutex<Option<Rec>>>,
    conns: Mutex<HashMap<String, MidiInputConnection<()>>>,
    /// Mensajes recibidos (para ver en la UI que llega algo).
    events: Arc<AtomicU32>,
}

#[derive(Serialize)]
pub struct Port {
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiStatus {
    connected: Vec<String>,
    events: u32,
}

fn parse(bytes: &[u8]) -> Option<MidiEvent> {
    let (&status, data) = bytes.split_first()?;
    let channel = MidiChannel::from_index(status & 0x0F)?;
    let d1 = *data.first().unwrap_or(&0) & 0x7F;
    let d2 = *data.get(1).unwrap_or(&0) & 0x7F;
    Some(match status & 0xF0 {
        0x90 if d2 > 0 => MidiEvent::NoteOn { channel, note: d1, velocity: d2 },
        // Nota encendida con velocidad 0 = apagada
        0x90 | 0x80 => MidiEvent::NoteOff { channel, note: d1, velocity: d2 },
        0xB0 => MidiEvent::ControlChange { channel, controller: d1, value: d2 },
        0xC0 => MidiEvent::ProgramChange { channel, program: d1 },
        0xE0 => MidiEvent::PitchBend { channel, value: ((d2 as u16) << 7) | d1 as u16 },
        _ => return None,
    })
}

#[tauri::command(async)]
pub fn midi_ports() -> Result<Vec<Port>, String> {
    let input = MidiInput::new("Riff").map_err(|e| e.to_string())?;
    Ok(input.ports().iter().filter_map(|p| input.port_name(p).ok()).map(|name| Port { name }).collect())
}

/// Deja conectados exactamente los puertos pedidos (por nombre). Devuelve un mensaje por cada uno que falle.
#[tauri::command(async)]
pub fn midi_connect(midi: tauri::State<'_, Midi>, plugins: tauri::State<'_, PluginHost>, ports: Vec<String>) -> Vec<String> {
    let mut conns = midi.conns.lock().unwrap();
    // Cerrar los que sobran (Windows no deja compartir el puerto)
    let gone: Vec<String> = conns.keys().filter(|k| !ports.contains(k)).cloned().collect();
    for name in gone {
        if let Some(c) = conns.remove(&name) {
            c.close();
        }
    }
    let mut errors = Vec::new();
    for name in ports {
        if conns.contains_key(&name) {
            continue;
        }
        match open(&midi, &plugins, &name) {
            Ok(c) => {
                conns.insert(name, c);
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    errors
}

fn open(midi: &Midi, plugins: &PluginHost, name: &str) -> Result<MidiInputConnection<()>, String> {
    let input = MidiInput::new("Riff").map_err(|e| e.to_string())?;
    let p = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).is_ok_and(|n| n == name))
        .ok_or("no se encuentra el dispositivo (¿desconectado?)")?;
    let chain: Arc<Chain> = plugins.chain();
    let events = midi.events.clone();
    let rec = midi.rec.clone();
    let port = name.to_string();
    input
        .connect(
            &p,
            "riff-in",
            move |_, bytes, _| {
                events.fetch_add(1, Ordering::Relaxed);
                if let Some(ev) = parse(bytes) {
                    if let Some(r) = rec.lock().unwrap().as_mut() {
                        let t = r.t0.elapsed().as_secs_f64();
                        match &ev {
                            MidiEvent::NoteOn { channel, note, velocity } => {
                                r.events.push((t, true, channel.as_index(), *note, *velocity, port.clone()))
                            }
                            MidiEvent::NoteOff { channel, note, .. } => {
                                r.events.push((t, false, channel.as_index(), *note, 0, port.clone()))
                            }
                            _ => {}
                        }
                    }
                    chain.send_midi(&port, ev);
                }
            },
            (),
        )
        .map_err(|e| format!("no se pudo abrir (¿lo tiene abierto otro programa?): {e}"))
}

#[tauri::command(async)]
pub fn midi_status(midi: tauri::State<'_, Midi>) -> MidiStatus {
    MidiStatus { connected: midi.conns.lock().unwrap().keys().cloned().collect(), events: midi.events.load(Ordering::Relaxed) }
}

/// Empieza a anotar lo que se toca. Devuelve las pistas (de las armadas) que tienen un
/// instrumento y por tanto graban MIDI.
#[tauri::command(async)]
pub fn midi_record_start(midi: tauri::State<'_, Midi>, plugins: tauri::State<'_, PluginHost>, tracks: Vec<String>) -> Vec<String> {
    let chain = plugins.chain();
    let tracks = chain.instrument_tracks(&tracks);
    let with_port: Vec<(String, String)> = tracks.iter().map(|t| (t.clone(), chain.midi_port(t))).collect();
    *midi.rec.lock().unwrap() = (!tracks.is_empty()).then(|| Rec { t0: Instant::now(), tracks: with_port, events: Vec::new() });
    tracks
}

/// Las notas tocadas hasta ahora en la toma (las que siguen sonando se cierran en este instante):
/// sirve para dibujarlas mientras se graba.
#[tauri::command(async)]
pub fn midi_record_peek(midi: tauri::State<'_, Midi>) -> Vec<NoteOut> {
    let guard = midi.rec.lock().unwrap();
    let Some(rec) = guard.as_ref() else { return Vec::new() };
    let now = rec.t0.elapsed().as_secs_f64();
    let mut open: HashMap<(u8, u8), (f64, u8)> = HashMap::new();
    let mut notes = Vec::new();
    for (t, on, ch, note, vel, _) in rec.events.iter() {
        if *on {
            open.insert((*ch, *note), (*t, *vel));
        } else if let Some((start, vel)) = open.remove(&(*ch, *note)) {
            notes.push(NoteOut { start, dur: (t - start).max(0.02), note: *note, vel, ch: *ch });
        }
    }
    for ((ch, note), (start, vel)) in open {
        notes.push(NoteOut { start, dur: (now - start).max(0.02), note, vel, ch });
    }
    notes
}

/// Para de anotar y devuelve las notas de cada pista (con el tiempo en segundos desde `midi_record_start`).
#[tauri::command(async)]
pub fn midi_record_stop(midi: tauri::State<'_, Midi>) -> Option<Recorded> {
    let rec = midi.rec.lock().unwrap().take()?;
    let length = rec.t0.elapsed().as_secs_f64();
    let tracks = rec
        .tracks
        .iter()
        .map(|(track, port)| {
            let mut open: HashMap<(u8, u8), (f64, u8)> = HashMap::new();
            let mut notes = Vec::new();
            for (t, on, ch, note, vel, from) in rec.events.iter().filter(|e| port.is_empty() || &e.5 == port) {
                let (t, ch, note, vel) = (*t, *ch, *note, *vel);
                let _ = from;
                if *on {
                    open.insert((ch, note), (t, vel));
                } else if let Some((start, vel)) = open.remove(&(ch, note)) {
                    notes.push(NoteOut { start, dur: (t - start).max(0.02), note, vel, ch });
                }
            }
            // Las notas que seguían sonando al parar se cortan ahí
            for ((ch, note), (start, vel)) in open {
                notes.push(NoteOut { start, dur: (length - start).max(0.02), note, vel, ch });
            }
            notes.sort_by(|a, b| a.start.total_cmp(&b.start));
            TrackNotes { track: track.clone(), notes }
        })
        .collect();
    Some(Recorded { tracks, length })
}
