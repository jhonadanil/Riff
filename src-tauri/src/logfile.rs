//! Registro en archivo: la app instalada no tiene terminal, así que los diagnósticos (drivers,
//! plugins, panics) se guardan en `%LOCALAPPDATA%\com.riff.daw\logs\riff.log`.
//!
//! No se llama desde el callback de audio salvo cuando el driver informa de un error.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Al superar este tamaño, el registro pasa a `riff.old.log` en el siguiente arranque.
const MAX_BYTES: u64 = 1024 * 1024;

static FILE: OnceLock<Mutex<File>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Abre el registro dentro de `dir` y anota también los panics.
pub fn init(dir: &Path) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join("riff.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("riff.old.log"));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
    let _ = FILE.set(Mutex::new(file));
    let _ = PATH.set(path);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(format!("PANIC: {info}"));
        previous(info);
    }));
}

/// Ruta del archivo de registro, si se pudo abrir.
pub fn path() -> Option<&'static Path> {
    PATH.get().map(PathBuf::as_path)
}

/// Añade una línea (con fecha UTC) al registro y a la terminal.
pub fn write(msg: impl std::fmt::Display) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let line = format!("{} {msg}", utc(secs));
    eprintln!("{line}");
    if let Some(Ok(mut f)) = FILE.get().map(|f| f.lock()) {
        let _ = writeln!(f, "{line}");
    }
}

/// "AAAA-MM-DD HH:MM:SSZ" a partir de los segundos desde 1970.
fn utc(secs: u64) -> String {
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Algoritmo «civil_from_days» (calendario gregoriano, contando desde marzo)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::utc;

    #[test]
    fn fechas() {
        assert_eq!(utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00:00Z");
        assert_eq!(utc(1_767_225_599), "2025-12-31 23:59:59Z");
    }
}
