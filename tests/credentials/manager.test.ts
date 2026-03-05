import { describe, it, expect } from "vitest";
import { LocalKms } from "../../src/credentials/local-kms.js";
import { CredentialManager } from "../../src/credentials/manager.js";

describe("CredentialManager", () => {
  it("encrypts and decrypts a string round-trip", async () => {
    const kms = new LocalKms();
    const manager = new CredentialManager(kms);
    const plaintext = "super-secret-api-key-12345";

    const encrypted = await manager.encrypt(plaintext);
    const decrypted = await manager.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for the same input", async () => {
    const kms = new LocalKms();
    const manager = new CredentialManager(kms);
    const plaintext = "same-input-every-time";

    const encrypted1 = await manager.encrypt(plaintext);
    const encrypted2 = await manager.encrypt(plaintext);

    expect(encrypted1.ciphertext.equals(encrypted2.ciphertext)).toBe(false);
    expect(encrypted1.iv.equals(encrypted2.iv)).toBe(false);
  });

  it("fails to decrypt with tampered ciphertext", async () => {
    const kms = new LocalKms();
    const manager = new CredentialManager(kms);
    const plaintext = "do-not-tamper";

    const encrypted = await manager.encrypt(plaintext);

    // Flip a byte in the ciphertext
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 0xff;

    const tamperedPayload = {
      ...encrypted,
      ciphertext: tampered,
    };

    await expect(manager.decrypt(tamperedPayload)).rejects.toThrow();
  });
});
