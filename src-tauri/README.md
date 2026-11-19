# tradoor desktop

A [Tauri 2](https://tauri.app) shell that shows tradoor terminal in a native window.

The window does not bundle the web app or the backend. It opens a running `tradoor-server`, which serves the web app, `/api` and `/data` from one origin, so the page needs no CORS settings and no changes. By default the window opens `http://127.0.0.1:8080`. Set `TRADOOR_URL` to open another address, such as a hosted site.

The page is remote content as far as Tauri is concerned, so it gets no IPC capability (`capabilities/default.json` grants nothing). Links to any other site open in the system browser. That includes the Telegram sign-in link.

## Layout

```text
src-tauri/
  Cargo.toml            its own [workspace], so the repository's workspace does not adopt it
  build.rs
  tauri.conf.json       no windows declared; main.rs builds the window
  capabilities/         empty permission set
  src/main.rs           window, TRADOOR_URL, external links
  ui/index.html         placeholder: Tauri requires a frontendDist, the window never shows it
  icons/                generated from web/public/icon-512.png
```

## Requirements

- Rust 1.95 or newer, and the MSVC build tools on Windows (Visual Studio Build Tools with the C++ workload)
- Tauri CLI 2: `cargo install tauri-cli --version "^2" --locked`
- WebView2, which Windows 10 and 11 normally have already
- A working `tradoor-server` and PostgreSQL (see below)

## Run it

Build the engine and the web app once, from the repository root, in Git Bash:

```sh
./scripts/build-wasm.sh        # needs wasm-bindgen-cli 0.2.128 and wasm-opt
cargo build --release -p tradoor-server
(cd web && deno install && deno task build)
```

`scripts/build-wasm.sh` fails with "an import the glue does not name" when `wasm-opt` is not installed. On Windows, `npm i -g binaryen` provides it.

Put the settings in `.env` at the repository root:

```sh
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/tradoor
TRADOOR_DATA_DIR=./data
TRADOOR_BIND=127.0.0.1:8080
TRADOOR_WEB_DIR=./web/dist
```

URL-encode any special characters in the password. A local PostgreSQL works; Docker is not needed. The server applies its migrations when it starts.

Start the server, then the window:

```sh
set -a; . ./.env; set +a
./target/release/tradoor-server        # http://127.0.0.1:8080

cd src-tauri
cargo tauri dev                        # or: cargo tauri build
```

`cargo tauri build` makes an installer in `src-tauri/target/release/bundle/`. The installer holds the window only. It does not include the server or the database.

## Sign-in

The app works without signing in: the webview makes a random id and sends it in the `x-tradoor-owner` header, and that id keeps your drawings, layouts, watchlists and alerts. The id lives in the webview's storage, so clearing the app's data loses it.

Sign in with Telegram, in Settings, is how an account is recovered on another device. The server needs `TRADOOR_TELEGRAM_TOKEN` (a bot from @BotFather) and `TRADOOR_SITE_URL` for it. Without the token, Settings says the server has no bot. Sessions are sent in the `x-tradoor-session` header, not in cookies, so they work from the webview.

## Open points

- Only Windows (WebView2) has been tried. macOS (WKWebView) and Linux (WebKitGTK) are weaker on WebGL2 and OffscreenCanvas in workers, which the chart engine uses.
- `window.open` popups are not handled; only navigations leave the window.
- The window opens before the server is ready. If the server is down the window shows a load error, so start the server first.
- The server can run on PostgreSQL 17; the README states 18. Nothing in the migrations needs 18, but it is untested.
