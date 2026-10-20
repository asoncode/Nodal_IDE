#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::{BufRead, BufReader}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicUsize, Ordering}, Mutex}};
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}, Emitter, Manager};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Connection { url: String, token: String }
struct Runtime { connection: Connection, child: Mutex<Option<Child>> }
#[tauri::command]
fn connection(runtime: tauri::State<Runtime>) -> Connection { runtime.connection.clone() }

fn create_workspace_window(app: &tauri::AppHandle) -> Result<String, String> {
    static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);
    let mut config = app.config().app.windows.iter().find(|window| window.label == "main")
        .ok_or("Main window configuration unavailable")?.clone();
    config.label = format!("workspace-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let label = config.label.clone();
    tauri::WebviewWindowBuilder::from_config(app, &config).map_err(|error| error.to_string())?
        .build().map_err(|error| error.to_string())?;
    Ok(label)
}

#[tauri::command]
async fn new_window(app: tauri::AppHandle) -> Result<String, String> {
    create_workspace_window(&app)
}

fn native_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let mut file_menu = None;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == "File" { file_menu = Some(submenu.clone()); break; }
        }
    }
    let file_menu = match file_menu {
        Some(submenu) => submenu,
        None => {
            let submenu = Submenu::with_items(app, "File", true, &[
                &PredefinedMenuItem::close_window(app, None)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            menu.prepend(&submenu)?;
            submenu
        }
    };
    file_menu.prepend_items(&[
        &MenuItem::with_id(app, "new-window", "New Window", true, Some("CmdOrCtrl+Shift+N"))?,
        &MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+O"))?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
        &PredefinedMenuItem::separator(app)?,
    ])?;
    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(native_menu)
        .on_menu_event(|app, event| {
            let event_name = match event.id().as_ref() {
                "new-window" => {
                    if let Err(error) = create_workspace_window(app) { eprintln!("Unable to create Nodal window: {error}"); }
                    return;
                }
                "open-folder" => "nodal:open-folder",
                "save" => "nodal:save",
                _ => return,
            };
            if let Some(window) = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false)) {
                if let Err(error) = app.emit_to(window.label(), event_name, ()) { eprintln!("Unable to dispatch Nodal menu action: {error}"); }
            }
        })
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
        .invoke_handler(tauri::generate_handler![connection, new_window])
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
