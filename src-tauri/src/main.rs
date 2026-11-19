//! tradoor terminal as a desktop window.
//!
//! The window shows a running `tradoor-server`, which serves the web app, `/api`
//! and `/data` from one origin, so the page needs no CORS and no change. Start
//! the server first (`TRADOOR_WEB_DIR=./web/dist tradoor-server`); it defaults to
//! http://127.0.0.1:8080. `TRADOOR_URL` points the window elsewhere, such as a
//! hosted site.
//!
//! The page is remote content to Tauri: it is given no IPC capability. Links to
//! any other site, Telegram's sign-in among them, open in the system browser.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_URL: &str = "http://127.0.0.1:8080";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let url: tauri::Url = std::env::var("TRADOOR_URL").unwrap_or_else(|_| DEFAULT_URL.into()).parse()?;
            let home = (url.scheme().to_string(), url.host_str().unwrap_or_default().to_string(), url.port_or_known_default());
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("tradoor terminal")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .on_navigation(move |to| {
                    let ours = (to.scheme().to_string(), to.host_str().unwrap_or_default().to_string(), to.port_or_known_default()) == home;
                    if !ours && matches!(to.scheme(), "http" | "https" | "tg") {
                        let _ = handle.opener().open_url(to.as_str(), None::<&str>);
                    }
                    ours
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("running the tradoor desktop app");
}
