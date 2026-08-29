import {
  chmod,
  mkdir,
  readdir,
  rename,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DETERMINISTIC_MTIME } from "../constants.js";
import { BackupError } from "../shared/errors.js";
import { stringifyCanonical } from "./canonical-json.js";

export class SnapshotWriter {
  readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public path(relativePath: string): string {
    const absolute = resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${sep}`)) {
      throw new BackupError(
        `Snapshot path escapes output directory: ${relativePath}`,
      );
    }
    return absolute;
  }

  public async writeJson(
    relativePath: string,
    value: unknown,
    deterministic = true,
  ): Promise<void> {
    await this.write(relativePath, stringifyCanonical(value), deterministic);
  }

  public async write(
    relativePath: string,
    data: string | Uint8Array,
    deterministic = true,
  ): Promise<void> {
    const destination = this.path(relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, data, { mode: 0o644, flag: "wx" });
      await rename(temporary, destination);
      await chmod(destination, 0o644);
      if (deterministic)
        await utimes(destination, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export async function normalizeSnapshotDirectories(
  root: string,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => visit(resolve(directory, entry.name))),
    );
    await chmod(directory, 0o755);
    await utimes(directory, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
  };
  await visit(resolve(root));
}
