import { createPool, type Pool } from "./connection.js";
import { env } from "../config/env.js";

/**
 * Global PostgreSQL pool singleton for worker modules (session, permissions).
 * Lazily initialized on first access.
 */
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = createPool(env.DATABASE_URL);
  }
  return _pool;
}

/**
 * Set the pool instance (allows app.ts to share its pool with worker modules)
 */
export function setPool(p: Pool): void {
  _pool = p;
}

/**
 * For backward compatibility — a proxy that delegates to the lazy singleton.
 * Modules importing `pool` will use the shared instance.
 */
export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const p = getPool();
    const value = Reflect.get(p, prop, receiver);
    return typeof value === "function" ? value.bind(p) : value;
  },
});

/**
 * Close the pool gracefully
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
