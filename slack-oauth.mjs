#!/usr/bin/env node
/**
 * Quick Slack OAuth token grabber.
 *
 * Usage:
 *   1. Set CLIENT_ID and CLIENT_SECRET below (from api.slack.com/apps > Basic Information)
 *   2. Make sure User Token Scopes include: chat:write, channels:history, channels:read
 *   3. Run: node slack-oauth.mjs
 *   4. Browser opens → log in as the user you want a token for → authorize
 *   5. Token prints to console
 *
 * Repeat for each user (hi, mark_baum) by logging into Slack as that user first.
 */

import https from "node:https";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── FILL THESE IN ───────────────────────────────────────────────
const CLIENT_ID = process.env.SLACK_CLIENT_ID || "10624519535703.10668359644416";
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "8ba3f05d60db06878bb0f14d02e30d05";
// ─────────────────────────────────────────────────────────────────

const PORT = 9876;
const REDIRECT_URI = `https://localhost:${PORT}/callback`;
const USER_SCOPES = "chat:write,channels:history,channels:read";

const authUrl =
  `https://slack.com/oauth/v2/authorize?client_id=${CLIENT_ID}` +
  `&user_scope=${USER_SCOPES}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

// Generate self-signed cert
const certDir = mkdtempSync(join(tmpdir(), "slack-oauth-"));
const keyPath = join(certDir, "key.pem");
const certPath = join(certDir, "cert.pem");
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "ignore" }
);

const server = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
    console.error("\n❌ OAuth error:", error);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h2>No code received</h2>");
    return;
  }

  // Exchange code for token
  const tokenResp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await tokenResp.json();

  if (!data.ok) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Token exchange failed: ${data.error}</h2><p>You can close this tab.</p>`);
    console.error("\n❌ Token exchange failed:", data.error);
    server.close();
    return;
  }

  const userToken = data.authed_user?.access_token;
  const userId = data.authed_user?.id;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h2>✅ Got token for user ${userId}</h2><p>Check your terminal. You can close this tab.</p>`);

  console.log("\n✅ Success!");
  console.log("   User ID:", userId);
  console.log("   Token:  ", userToken);
  console.log("\nPaste into .env or GitHub Secrets as needed.\n");

  server.close();
  rmSync(certDir, { recursive: true, force: true });
});

server.listen(PORT, () => {
  console.log(`\nListening on http://localhost:${PORT}`);
  console.log("Opening browser for Slack OAuth...\n");
  console.log("If browser doesn't open, visit:\n", authUrl, "\n");

  // Open browser (macOS)
  try {
    execSync(`open "${authUrl}"`);
  } catch {
    // User can manually open the URL
  }
});
