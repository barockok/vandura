/**
 * Memory utilities — sensitive data detection for the PreToolUse hook.
 *
 * The agent uses Claude Code's built-in Read/Write/Glob tools for memory files.
 * This module provides the guard that prevents secrets from being persisted.
 */

/**
 * Patterns matching sensitive data that must not be saved to memory.
 */
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/,          // Anthropic/OpenAI API keys
  /sk_[a-zA-Z0-9_-]{10,}/,          // Stripe-style keys
  /xox[bpars]-[a-zA-Z0-9-]+/,       // Slack tokens
  /glsa_[a-zA-Z0-9]+/,              // Grafana service account tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,  // Bearer tokens
  /password\s*[=:]\s*\S+/i,         // password=... or password: ...
  /secret\s*[=:]\s*\S+/i,           // secret=... or secret: ...
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, // PEM private keys
];

/**
 * Check if content contains sensitive data (API keys, tokens, passwords).
 */
export function containsSensitiveData(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}
