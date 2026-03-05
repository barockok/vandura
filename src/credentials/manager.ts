import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Kms } from "./local-kms.js";

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  dekEncrypted: Buffer;
}

export class CredentialManager {
  private readonly kms: Kms;

  constructor(kms: Kms) {
    this.kms = kms;
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
}
