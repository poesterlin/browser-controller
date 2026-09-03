export declare function withTimeout<T>(
  operation: PromiseLike<T> | T,
  timeoutMs: number,
  code: string,
): Promise<T>;
