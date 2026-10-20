#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::{BufRead, BufReader}, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::Manager;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Connection { url: String, token: String }
struct Runtime { connection: Connection, child: Mutex<Option<Child>> }
#[tauri::command]
fn connection(runtime: tauri::State<Runtime>) -> Connection { runtime.connection.clone() }

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (node, script, cwd) = if cfg!(debug_assertions) {
                let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
                (std::env::var("NODAL_NODE").unwrap_or_else(|_| "node".into()), root.join("dist/runtime/main.js"), root)
            } else {
                let root = app.path().resource_dir()?.join("sidecar");
                let executable = if cfg!(windows) { "node.exe" } else { "node" };
                (root.join(executable).to_string_lossy().into_owned(), root.join("main.js"), root)
            };
            let mut child = Command::new(node).arg(script).current_dir(cwd)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
            let mut line = String::new();
            let stdout = child.stdout.take().ok_or("Sidecar stdout unavailable")?;
            BufReader::new(stdout).read_line(&mut line)?;
            let connection: Connection = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => { let _ = child.kill(); return Err(format!("Nodal runtime did not start: {error}").into()); }
            };
            app.manage(Runtime { connection, child: Mutex::new(Some(child)) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![connection])
        .build(tauri::generate_context!())
        .expect("Unable to launch Nodal")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Runtime>().child.lock().unwrap().take() {
                    // Closing stdin lets the sidecar abort sessions/process groups and flush SQLite.
                    drop(child.stdin.take());
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while std::time::Instant::now() < deadline {
                        if child.try_wait().ok().flatten().is_some() { return; }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    let _ = child.kill(); let _ = child.wait();
                }
            }
        });
}
