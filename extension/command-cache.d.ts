export class CommandCache<T = unknown> {
  constructor(limit?: number);
  clear(): void;
  run(key: string, operation: () => Promise<T> | T): Promise<T>;
}
