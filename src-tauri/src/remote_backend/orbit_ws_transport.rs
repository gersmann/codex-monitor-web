use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::transport::{
    dispatch_incoming_line, mark_disconnected, PendingMap, RemoteTransport, RemoteTransportConfig,
    TransportConnection, TransportFuture,
};

pub(crate) struct OrbitWsTransport;

impl RemoteTransport for OrbitWsTransport {
    fn connect(&self, app: AppHandle, config: RemoteTransportConfig) -> TransportFuture {
        Box::pin(async move {
            let RemoteTransportConfig::OrbitWs { ws_url, .. } = config else {
                return Err("invalid transport config for orbit websocket transport".to_string());
            };

            let ws_url = normalize_ws_url(&ws_url)?;
            let (stream, _response) = connect_async(&ws_url)
                .await
                .map_err(|err| format!("Failed to connect to Orbit relay at {ws_url}: {err}"))?;
            let (mut writer, mut reader) = stream.split();

            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
            let pending = Arc::new(Mutex::new(PendingMap::new()));
            let pending_for_writer = Arc::clone(&pending);
            let pending_for_reader = Arc::clone(&pending);

            let connected = Arc::new(AtomicBool::new(true));
            let connected_for_writer = Arc::clone(&connected);
            let connected_for_reader = Arc::clone(&connected);

            tokio::spawn(async move {
                while let Some(message) = out_rx.recv().await {
                    if writer.send(Message::Text(message.into())).await.is_err() {
                        mark_disconnected(&pending_for_writer, &connected_for_writer).await;
                        break;
                    }
                }
            });

            tokio::spawn(async move {
                while let Some(frame) = reader.next().await {
                    match frame {
                        Ok(Message::Text(text)) => {
                            dispatch_incoming_payload(&app, &pending_for_reader, text.as_ref())
                                .await;
                        }
                        Ok(Message::Binary(bytes)) => {
                            if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                                dispatch_incoming_payload(&app, &pending_for_reader, &text).await;
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                        Ok(Message::Frame(_)) => {}
                        Err(_) => break,
                    }
                }

                mark_disconnected(&pending_for_reader, &connected_for_reader).await;
            });

            Ok(TransportConnection {
                out_tx,
                pending,
                connected,
            })
        })
    }
}

async fn dispatch_incoming_payload(
    app: &AppHandle,
    pending: &Arc<Mutex<PendingMap>>,
    payload: &str,
) {
    for line in protocol_lines(payload) {
        dispatch_incoming_line(app, pending, line).await;
    }
}

fn protocol_lines(payload: &str) -> impl Iterator<Item = &str> {
    payload
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
}

fn normalize_ws_url(ws_url: &str) -> Result<String, String> {
    let raw_url = ws_url.trim();
    if raw_url.is_empty() {
        return Err("Orbit provider requires orbitWsUrl in app settings.".to_string());
    }

    let normalized = if let Some(rest) = raw_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = raw_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if raw_url.starts_with("wss://") || raw_url.starts_with("ws://") {
        raw_url.to_string()
    } else {
        return Err("orbitWsUrl must start with https://, http://, wss://, or ws://".to_string());
    };
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::{normalize_ws_url, protocol_lines};

    #[test]
    fn normalize_ws_url_rewrites_http_scheme() {
        let value =
            normalize_ws_url("https://bridge.example.workers.dev/ws/session-1").expect("ws url");
        assert_eq!(value, "wss://bridge.example.workers.dev/ws/session-1");
    }

    #[test]
    fn normalize_ws_url_keeps_ws_scheme() {
        let value =
            normalize_ws_url("wss://bridge.example.workers.dev/ws/session-1").expect("ws url");
        assert_eq!(value, "wss://bridge.example.workers.dev/ws/session-1");
    }

    #[test]
    fn protocol_lines_splits_multiline_payload() {
        let payload = "{\"id\":1}\n{\"id\":2}\n";
        let lines: Vec<&str> = protocol_lines(payload).collect();
        assert_eq!(lines, vec!["{\"id\":1}", "{\"id\":2}"]);
    }

    #[test]
    fn protocol_lines_trims_and_skips_empty_lines() {
        let payload = "  {\"id\":1}  \n\n\t{\"id\":2}\r\n";
        let lines: Vec<&str> = protocol_lines(payload).collect();
        assert_eq!(lines, vec!["{\"id\":1}", "{\"id\":2}"]);
    }
}
