export function withTimeout(operation, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
