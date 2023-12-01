import crypto from "crypto";
import {
  AppId,
  ClientType,
  RequestFormat,
  Language,
  RequestSource,
} from "./Constants";
import { timestamp } from "./timestamp";

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

  const query = Object.keys(form)
    .sort()
    .map((key) => `${key}=${form[key]}`)
    .join("&");
  const payload = path + query + appKey;
  return crypto.createHash("sha256").update(payload).digest("hex");
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

export function baseForm() {
  const d: Record<string, string | number> = {
    appId: AppId,
    clientType: ClientType,
    format: RequestFormat,
    language: Language,
    src: RequestSource,
    stamp: timestamp(),
  };
  return d;
}
