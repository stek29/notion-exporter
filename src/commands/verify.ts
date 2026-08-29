import { VerificationError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { verifySnapshot } from "../verify/verifier.js";

export async function runVerify(path: string, logger: Logger): Promise<void> {
  const result = await verifySnapshot(path);
  if (!result.valid) throw new VerificationError(result.errors);
  logger.info(
    "Snapshot is valid",
    result.counts ? { ...result.counts } : undefined,
  );
}
