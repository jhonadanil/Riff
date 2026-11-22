mod audio;
mod midi;
mod plugins;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(audio::Engine::default())
        .manage(midi::Midi::default())
        .setup(|app| {
            use tauri::Manager;
            let chain = app.state::<audio::Engine>().chain();
            app.manage(plugins::PluginHost::new(chain));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::audio_hosts,
            audio::audio_devices,
            audio::audio_start,
            audio::audio_stop,
            audio::audio_info,
            audio::audio_set_monitor,
            audio::audio_set_input_channel,
            audio::audio_meter,
            plugins::plugin_scan,
            plugins::plugin_list,
            plugins::plugin_load,
            plugins::plugin_remove,
            plugins::plugin_editor,
            plugins::plugin_move,
            plugins::plugin_bypass,
            plugins::plugin_prune,
            plugins::plugin_snapshot,
            plugins::plugin_restore,
            plugins::plugin_set_monitored,
            plugins::midi_set_clips,
            plugins::midi_set_mix,
            plugins::midi_set_offset,
            plugins::midi_play,
            plugins::midi_stop,
            plugins::plugin_render,
            plugins::plugin_set_inputs,
            plugins::plugin_set_armed,
            plugins::plugin_overview,
            plugins::plugin_set_midi_ports,
            plugins::audio_record_start,
            plugins::audio_record_stop,
            midi::midi_record_start,
            midi::midi_record_stop,
            midi::midi_record_peek,
            midi::midi_ports,
            midi::midi_connect,
            midi::midi_status,
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
