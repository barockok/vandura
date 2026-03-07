import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Kms } from "./local-kms.js";
import type { Pool } from "../db/connection.js";

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  dekEncrypted: Buffer;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
}

export interface TokenHealth {
  status: "valid" | "expiring" | "expired" | "error" | "unknown";
  expiresAt?: Date;
  lastRefresh?: Date;
  lastError?: string;
}

export class CredentialManager {
  private readonly kms: Kms;
  private readonly pool: Pool;

  constructor(kms: Kms, pool: Pool) {
    this.kms = kms;
    this.pool = pool;
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    const { plainDek, encryptedDek } = await this.kms.generateDek();

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", plainDek, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Zero out the plain DEK from memory
    plainDek.fill(0);

    return {
      ciphertext,
      iv,
      tag,
      dekEncrypted: encryptedDek,
    };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    const plainDek = await this.kms.decryptDek(payload.dekEncrypted);

    const decipher = createDecipheriv("aes-256-gcm", plainDek, payload.iv);
    decipher.setAuthTag(payload.tag);

    const decrypted = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]);

    // Zero out the plain DEK from memory
    plainDek.fill(0);

    return decrypted.toString("utf8");
  }

  /**
   * Get OAuth token for a user, refreshing if needed
   */
  async getOAuthToken(
    userId: string,
    provider: string,
    refreshCallback?: (refreshToken: string) => Promise<OAuthToken>,
  ): Promise<OAuthToken | null> {
    const result = await this.pool.query(
      "SELECT * FROM user_connections WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const expiresAt = row.token_expires_at as Date | null;

    // Check if token is expired or expiring soon (within 5 minutes)
    const now = new Date();
    const expiringSoon = expiresAt && expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

    if (expiringSoon && row.refresh_token_enc && refreshCallback) {
      // Token is expiring, try to refresh
      try {
        const refreshToken = await this.decrypt({
          ciphertext: row.refresh_token_enc,
          iv: row.token_iv,
          tag: row.token_tag,
          dekEncrypted: row.dek_enc,
        });

        const newToken = await refreshCallback(refreshToken);

        // Update stored tokens
        const newAccessEnc = await this.encrypt(newToken.accessToken);
        await this.pool.query(
          `UPDATE user_connections SET
            access_token_enc = $1, token_iv = $2, token_tag = $3, dek_enc = $4,
            token_expires_at = $5, last_successful_use = now(),
            refresh_count = COALESCE(refresh_count, 0) + 1,
            health_status = 'valid', last_health_check = now()
          WHERE user_id = $6 AND provider = $7`,
          [
            newAccessEnc.ciphertext, newAccessEnc.iv, newAccessEnc.tag, newAccessEnc.dekEncrypted,
            newToken.expiresAt, userId, provider,
          ],
        );

        return newToken;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown refresh error";
        await this.pool.query(
          `UPDATE user_connections SET
            last_refresh_error = $1, health_status = 'error', last_health_check = now()
          WHERE user_id = $2 AND provider = $3`,
          [errorMessage, userId, provider],
        );
        throw new Error(`OAuth refresh failed for ${provider}: ${errorMessage}`, { cause: err });
      }
    }

    // Token still valid, just decrypt and return
    const accessToken = await this.decrypt({
      ciphertext: row.access_token_enc,
      iv: row.token_iv,
      tag: row.token_tag,
      dekEncrypted: row.dek_enc,
    });

    // Update last successful use
    await this.pool.query(
      "UPDATE user_connections SET last_successful_use = now() WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );

    return {
      accessToken,
      expiresAt: expiresAt || undefined,
      scopes: row.scopes || undefined,
    };
  }

  /**
   * Check health of all OAuth connections for a user
   */
  async checkOAuthHealth(userId?: string): Promise<TokenHealth[]> {
    const query = userId
      ? "SELECT * FROM user_connections WHERE user_id = $1"
      : "SELECT * FROM user_connections WHERE health_status != 'valid' OR token_expires_at IS NOT NULL";
    const params = userId ? [userId] : [];

    const result = await this.pool.query(query, params);
    const now = new Date();

    return result.rows.map((row: Record<string, unknown>) => {
      const expiresAt = row.token_expires_at as Date | null;
      const healthStatus = row.health_status as string;
      const lastError = row.last_refresh_error as string | null;

      let status: TokenHealth["status"] = healthStatus as TokenHealth["status"] || "unknown";

      if (expiresAt && expiresAt < now) {
        status = "expired";
      } else if (expiresAt && expiresAt.getTime() - now.getTime() < 24 * 60 * 60 * 1000) {
        status = "expiring";
      }

      return {
        status,
        expiresAt: expiresAt || undefined,
        lastRefresh: row.last_health_check as Date | undefined,
        lastError: lastError || undefined,
      };
    });
  }

  /**
   * Store OAuth tokens for a user
   */
  async storeOAuthToken(
    userId: string,
    provider: string,
    token: OAuthToken,
  ): Promise<void> {
    const accessEnc = await this.encrypt(token.accessToken);
    const refreshEnc = token.refreshToken ? await this.encrypt(token.refreshToken) : null;

    await this.pool.query(
      `INSERT INTO user_connections (
        user_id, provider, access_token_enc, refresh_token_enc,
        token_iv, token_tag, dek_enc, token_expires_at, scopes,
        health_status, last_health_check
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'valid', now())
      ON CONFLICT (user_id, provider) DO UPDATE SET
        access_token_enc = EXCLUDED.access_token_enc,
        refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, user_connections.refresh_token_enc),
        token_iv = EXCLUDED.token_iv,
        token_tag = EXCLUDED.token_tag,
        dek_enc = EXCLUDED.dek_enc,
        token_expires_at = EXCLUDED.token_expires_at,
        scopes = EXCLUDED.scopes,
        health_status = 'valid',
        last_health_check = now()`,
      [
        userId, provider,
        accessEnc.ciphertext, refreshEnc?.ciphertext,
        accessEnc.iv, accessEnc.tag, accessEnc.dekEncrypted,
        token.expiresAt, token.scopes ? JSON.stringify(token.scopes) : null,
      ],
    );
  }
}
