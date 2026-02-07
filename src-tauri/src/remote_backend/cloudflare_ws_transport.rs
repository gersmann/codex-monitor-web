use tauri::AppHandle;

use super::transport::{RemoteTransport, RemoteTransportConfig, TransportFuture};

pub(crate) struct CloudflareWsTransport;

impl RemoteTransport for CloudflareWsTransport {
    fn connect(&self, _app: AppHandle, config: RemoteTransportConfig) -> TransportFuture {
        Box::pin(async move {
            let RemoteTransportConfig::CloudflareWs {
                worker_url,
                session_id,
                ..
            } = config
            else {
                return Err(
                    "invalid transport config for cloudflare websocket transport".to_string(),
                );
            };

            Err(format!(
                "Cloudflare WebSocket transport is not implemented yet (worker: {worker_url}, session: {session_id}).",
            ))
        })
    }
}
