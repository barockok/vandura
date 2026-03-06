import { createApp } from "./app.js";

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

async function main() {
  const startupTimeout = parseInt(process.env.STARTUP_TIMEOUT_MS ?? "30000", 10);
  const app = await withTimeout(createApp(), startupTimeout, "createApp");
  await withTimeout(app.start(), startupTimeout, "app.start");
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
