import * as Constants from "./Constants";

export function calculate(data: ReadonlyArray<number> | Uint8Array) {
  let v = 0;
  for (const m of data) {
    let k = v ^ m;
    if (k > 256) k -= 256;
    if (k < 0) k += 256;
    v = Constants.crc8_854_table[k];
  }
  return v;
}
