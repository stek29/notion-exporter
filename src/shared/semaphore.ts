export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new RangeError("Semaphore maximum must be positive");
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
