import crypto from "crypto";

export function encode(data: ReadonlyArray<number>): number[] {
  const normalized: Array<number> = [];
  for (let b of data) {
    if (b >= 128) {
      b = b - 256;
    }
    normalized.push(b);
  }
  return normalized;
}

export function decode(data: ReadonlyArray<number>): number[] {
  const normalized: Array<number> = [];
  for (let b of data) {
    if (b < 0) {
      b = b + 256;
    }
    normalized.push(b);
  }
  return normalized;
}

// Returns a timestamp in the format YYYYMMDDHHmmss
export function getStamp(): string {
  const date = new Date();
  return date
    .toISOString()
    .slice(0, 19)
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/T/g, "");
}

export function getSign(
  path: string,
  form: Record<string, string | number | boolean>,
  appKey: string
) {
  if (path === "") {
    throw new Error("path required");
  }
  if (!form) {
    throw new Error("form required");
  }

  // let postfix = `/v1${path}`;
  // postfix = postfix.split("?")[0];
  const query = Object.keys(form)
    .sort()
    .map((key) => `${key}=${form[key]}`)
    .join("&");
  const payload = path + query + appKey;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function decryptAes(reply: string, dataKey: string) {
  if (!reply) {
    throw new Error("reply required");
  }
  if (!dataKey) {
    throw new Error("dataKey required");
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", dataKey, "");
  const dec = decipher.update(reply, "hex", "utf8");
  return dec.split(",").map(Number);
}

export function decryptAesString(reply: string, dataKey: string) {
  if (!reply) {
    throw new Error("reply required");
  }
  if (!dataKey) {
    throw new Error("dataKey required");
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", dataKey, "");
  return decipher.update(reply, "hex", "utf8");
}

export function encryptAes(query: number[] | Buffer, dataKey: string) {
  if (!query) {
    throw new Error("query required");
  }
  if (!dataKey) {
    throw new Error("dataKey required");
  }

  const cipher = crypto.createCipheriv("aes-128-ecb", dataKey, "");
  let ciph = cipher.update(query.join(","), "utf8", "hex");
  ciph += cipher.final("hex");
  return ciph;
}

export function getSignPassword(
  loginId: string,
  password: string,
  appKey: string
) {
  if (!loginId) {
    throw new Error("loginId required");
  }
  if (!password) {
    throw new Error("password required");
  }

  const pw = crypto.createHash("sha256").update(password).digest("hex");
  return crypto
    .createHash("sha256")
    .update(loginId + pw + appKey)
    .digest("hex");
}

export function generateDataKey(accessToken: string, appKey: string) {
  if (!accessToken) {
    throw new Error("access token required");
  }

  const md5AppKey = crypto.createHash("md5").update(appKey).digest("hex");
  const decipher = crypto.createDecipheriv(
    "aes-128-ecb",
    md5AppKey.slice(0, 16),
    ""
  );
  return decipher.update(accessToken, "hex", "utf8");
}
