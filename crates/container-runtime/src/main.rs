use std::{env, error::Error, io, net::SocketAddr};

use tokio::{net::TcpListener, signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    match (arguments.next(), arguments.next()) {
        (None, None) => {}
        (Some(argument), None) if argument == "--runtime-attestation-v1" => {
            #[cfg(target_os = "linux")]
            {
                let report = cinatoken_container_runtime::runtime_process_attestation()?;
                println!("{}", serde_json::to_string(&report)?);
                return Ok(());
            }
            #[cfg(not(target_os = "linux"))]
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "runtime attestation requires Linux",
            )
            .into());
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsupported container runtime argument",
            )
            .into());
        }
    }

    let port = cinatoken_container_runtime::container_port()?;
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(address).await?;

    axum::serve(listener, cinatoken_container_runtime::app())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        signal::ctrl_c()
            .await
            .expect("failed to install SIGINT handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {},
        _ = terminate => {},
    }
}
