use notify::{recommended_watcher, RecursiveMode, Watcher};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

const BATCH_WINDOW: Duration = Duration::from_millis(400);
const POLL_IDLE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct WatchState {
    handle: Mutex<Option<WatchHandle>>,
}

struct WatchHandle {
    _watcher: Box<dyn Watcher + Send>,
    stop: Arc<AtomicBool>,
}

/// Watch `root` recursively. Replaces any previous watch (dropping the old
/// watcher stops its event stream, which ends the batcher thread). Filesystem
/// events are coalesced for BATCH_WINDOW and emitted as one `fs-change` event.
pub fn watch_folder(
    app: tauri::AppHandle,
    state: &WatchState,
    root: &Path,
) -> Result<(), String> {
    stop_watch(state);

    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();

    std::thread::spawn(move || {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(POLL_IDLE) {
                Ok(Ok(event)) => {
                    let mut paths: Vec<String> = event
                        .paths
                        .iter()
                        .map(|p| dunce::simplified(p).to_string_lossy().into_owned())
                        .collect();
                    // Coalesce the burst that follows the first event.
                    let deadline = Instant::now() + BATCH_WINDOW;
                    while Instant::now() < deadline {
                        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                            Ok(Ok(ev)) => paths.extend(
                                ev.paths
                                    .iter()
                                    .map(|p| dunce::simplified(p).to_string_lossy().into_owned()),
                            ),
                            Ok(Err(_)) => {}
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    paths.sort();
                    paths.dedup();
                    let _ = app.emit("fs-change", json!({ "paths": paths }));
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    *state.handle.lock().unwrap() = Some(WatchHandle {
        _watcher: Box::new(watcher),
        stop,
    });
    Ok(())
}

fn stop_watch(state: &WatchState) {
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.stop.store(true, Ordering::Relaxed);
        // Dropping the watcher drops the sender; the thread exits on disconnect.
    }
}
