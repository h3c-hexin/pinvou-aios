use std::{env, path::PathBuf, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};
use uuid::Uuid;

fn socket_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("PINVOU_AIOS_SOCKET") {
        return Ok(PathBuf::from(path));
    }
    let root = env::var_os("PINVOU_AIOS_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".pinvou-aios")))
        .ok_or_else(|| "HOME is not set".to_owned())?;
    Ok(root.join("run/aios.sock"))
}

#[tauri::command]
async fn daemon_request(method: String, params: Value) -> Result<Value, String> {
    let id = Uuid::new_v4().to_string();
    let path = socket_path()?;
    let stream = tokio::time::timeout(Duration::from_secs(3), UnixStream::connect(&path))
        .await
        .map_err(|_| format!("连接 AIOS 守护进程超时：{}", path.display()))?
        .map_err(|error| format!("无法连接 AIOS 守护进程：{error}"))?;
    let (read_half, mut write_half) = stream.into_split();
    let request = json!({ "id": id, "method": method, "params": params });
    let mut encoded = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    write_half.write_all(&encoded).await.map_err(|error| error.to_string())?;

    let mut lines = BufReader::new(read_half).lines();
    tokio::time::timeout(Duration::from_secs(35), async {
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let response: Value = serde_json::from_str(line.trim_end_matches('\r')).map_err(|error| error.to_string())?;
            if response.get("id").and_then(Value::as_str) != Some(&id) {
                continue;
            }
            if response.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(response.get("result").cloned().unwrap_or(Value::Null));
            }
            return Err(response.get("error").and_then(Value::as_str).unwrap_or("unknown daemon error").to_owned());
        }
        Err("AIOS 守护进程提前关闭了连接".to_owned())
    })
    .await
    .map_err(|_| "AIOS 守护进程响应超时".to_owned())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_request])
        .run(tauri::generate_context!())
        .expect("failed to run Pinvou AIOS PAD UI");
}

