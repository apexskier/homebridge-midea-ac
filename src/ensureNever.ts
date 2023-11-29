export function ensureNever(x: never): never {
  throw new Error(`Unexpected object: ${x}`);
}
