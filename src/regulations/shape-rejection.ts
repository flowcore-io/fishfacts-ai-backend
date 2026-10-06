/** An identified domain command failed immutable shape validation. This is a
 * durable refusal, unlike dependency waiting or a retryable SQL failure. */
export class ShapeCommandRejectedError extends Error {
  readonly terminal = true;
}

export function verifyShapeCommand<T>(verify: () => T): T {
  try {
    return verify();
  } catch (error) {
    throw new ShapeCommandRejectedError(
      error instanceof Error ? error.message : "invalid immutable shape state",
    );
  }
}
