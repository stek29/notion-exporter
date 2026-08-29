import { readFile, stat } from "node:fs/promises";
import { BackupError } from "../shared/errors.js";

export async function loadNotionToken(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const direct = environment.NOTION_TOKEN;
  const file = environment.NOTION_TOKEN_FILE;
  if (direct && file)
    throw new BackupError("Set only one of NOTION_TOKEN or NOTION_TOKEN_FILE");
  const token = direct ?? (file ? await readTokenFile(file) : undefined);
  if (!token?.trim())
    throw new BackupError("NOTION_TOKEN or NOTION_TOKEN_FILE is required");
  const trimmed = token.trim();
  if (Buffer.byteLength(trimmed) > 16_384)
    throw new BackupError("Notion token is unexpectedly large");
  return trimmed;
}

async function readTokenFile(path: string): Promise<string> {
  try {
    const details = await stat(path);
    if (!details.isFile())
      throw new BackupError("NOTION_TOKEN_FILE is not a regular file");
    if (details.size > 16_384)
      throw new BackupError("NOTION_TOKEN_FILE is unexpectedly large");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("Could not read NOTION_TOKEN_FILE", { cause: error });
  }
}
