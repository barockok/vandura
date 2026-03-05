import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface Kms {
  generateDek(): Promise<{ plainDek: Buffer; encryptedDek: Buffer }>;
  decryptDek(encryptedDek: Buffer): Promise<Buffer>;
}

export class LocalKms implements Kms {
  private readonly masterKey: Buffer;

  constructor(masterKey?: Buffer) {
    this.masterKey = masterKey ?? randomBytes(32);
  }

  async generateDek(): Promise<{ plainDek: Buffer; encryptedDek: Buffer }> {
    const plainDek = randomBytes(32);
    const iv = randomBytes(12);

    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plainDek), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Pack as: iv[12] + tag[16] + ciphertext[32]
    const encryptedDek = Buffer.concat([iv, tag, ciphertext]);

    return { plainDek, encryptedDek };
  }

  async decryptDek(encryptedDek: Buffer): Promise<Buffer> {
    const iv = encryptedDek.subarray(0, 12);
    const tag = encryptedDek.subarray(12, 28);
    const ciphertext = encryptedDek.subarray(28);

    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
