//! rdc: a small, fast, native Discord client.
//!
//! Read `SAFETY.md` before changing anything in `safety.rs`, `rest.rs`,
//! `gateway.rs` or `token.rs`.

mod app;
mod backend;
mod gateway;
mod model;
mod rest;
mod safety;
mod token;

fn main() -> eframe::Result {
    // Logs go to stderr only. Default level keeps request details out; nothing
    // in this codebase ever logs the token or message contents.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RDC_LOG").unwrap_or_else(|_| "warn,rdc=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let handle = rt.handle().clone();

    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("rdc")
            .with_inner_size([1100.0, 700.0])
            .with_min_inner_size([640.0, 400.0]),
        ..Default::default()
    };
    let result = eframe::run_native(
        "rdc",
        options,
        Box::new(move |cc| Ok(Box::new(app::App::new(cc, &handle)))),
    );
    rt.shutdown_background();
    result
}
