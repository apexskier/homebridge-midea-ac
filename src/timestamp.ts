export function timestamp() {
  const now = new Date();
  return `${now.getUTCFullYear()}${now.getUTCMonth()}${now.getUTCDay()}${now.getUTCHours()}${now.getUTCMinutes()}${now.getUTCSeconds()}`;
}
