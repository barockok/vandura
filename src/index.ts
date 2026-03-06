import { createApp } from "./app.js";

async function main() {
  const app = await createApp();
  await app.start();
  console.log("Vandura is running!");

  // Graceful shutdown — close DB pools so tsx watch can restart cleanly
  const shutdown = async () => {
    console.log("Shutting down...");
    await app.pool.end();
    await app.toolDbPool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start Vandura:", err);
  process.exit(1);
});
