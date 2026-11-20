mod audio;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(audio::Engine::default())
        .invoke_handler(tauri::generate_handler![
            audio::audio_hosts,
            audio::audio_devices,
            audio::audio_start,
            audio::audio_stop,
            audio::audio_info,
            audio::audio_set_monitor,
            audio::audio_set_input_channel,
            audio::audio_meter,
        ])
        .on_window_event(|window, event| {
            use tauri::Manager;
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<audio::Engine>().shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
