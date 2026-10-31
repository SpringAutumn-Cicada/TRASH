import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Device-local secrets are deliberately separate from project files, SQLite and exports.
export class CredentialStore {
  private directory: string;
  constructor(root: string) { this.directory = join(root, "private", "ssh-credentials"); }
  private path(id: string): string { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.enc`); }
  private key(create: boolean): Buffer {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const path = join(this.directory, "device.key");
    if (!existsSync(path) && create) {
      if (readdirSync(this.directory).some(name => name.endsWith(".enc"))) throw new Error("Missing credential key");
      try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error("Invalid credential key");
    return key;
  }
  read(id: string): string | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    try {
      const bytes = readFileSync(path);
      if (bytes.length < 29 || bytes[0] !== 1) throw new Error("Invalid credential envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key(false), bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
    } catch { throw Object.assign(new Error("SSH_CREDENTIAL_STORE_FAILED"), { statusCode: 422 }); }
  }
  save(id: string, password: string): void {
    let temporary: string | undefined;
    try {
      const key = this.key(true), iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      temporary = join(this.directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.path(id));
    } catch { throw Object.assign(new Error("SSH_CREDENTIAL_STORE_FAILED"), { statusCode: 422 }); }
    finally { if (temporary) rmSync(temporary, { force: true }); }
  }
  remove(id: string): void {
    try { rmSync(this.path(id), { force: true }); }
    catch { throw Object.assign(new Error("SSH_CREDENTIAL_STORE_FAILED"), { statusCode: 422 }); }
  }
}
