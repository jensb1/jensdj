#[tokio::main]
async fn main() -> anyhow::Result<()> {
    djengine_rpc::run_stdio_server().await
}
