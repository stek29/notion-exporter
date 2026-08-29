export class BackupError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupError";
  }
}

export class VerificationError extends BackupError {
  public readonly errors: string[];

  public constructor(errors: string[]) {
    super(
      `Snapshot verification failed with ${errors.length} error(s): ${errors.slice(0, 3).join("; ")}`,
    );
    this.name = "VerificationError";
    this.errors = errors;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
