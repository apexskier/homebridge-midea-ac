import strftime from "strftime";

export function timestamp() {
  return strftime("%Y%m%d%H%M%S");
}
