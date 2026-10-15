/** Runs async jobs one at a time, in arrival order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private held = false;

  get busy(): boolean {
    return this.held;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.held = true;
      try {
        return await job();
      } finally {
        this.held = false;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
