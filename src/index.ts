import { createApp } from "./app.js";

async function main() {
  const app = await createApp();
  await app.start();
  console.log("Vandura is running!");
}

main().catch((err) => {
  console.error("Failed to start Vandura:", err);
  process.exit(1);
});
