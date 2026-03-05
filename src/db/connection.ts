import pg from "pg";

export type Pool = pg.Pool;

export function createPool(connectionUri: string): pg.Pool {
  return new pg.Pool({ connectionString: connectionUri });
}
