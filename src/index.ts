import { createApp } from "./app.js";

async function main() {
  const app = await createApp();
  await app.start();
  console.log("Vandura is running!");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Force exit after 5s if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit.");
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    try {
      await app.stop();
    } catch (err) {
      console.error("Error during shutdown:", err);
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start Vandura:", err);
  process.exit(1);
});
