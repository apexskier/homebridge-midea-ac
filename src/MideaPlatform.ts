import dgram from "node:dgram";
import crypto from "crypto";
import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import * as Constants from "./Constants";

import { MideaAccessory } from "./MideaAccessory";
import { MideaDeviceType } from "./enums/MideaDeviceType";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { timestamp } from "./timestamp";
import { MideaErrorCodes } from "./enums/MideaErrorCodes";

const InvalidSession = Symbol("InvalidSession");
type InvalidSession = typeof InvalidSession;

export class MideaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  mideaAccessories: MideaAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    api.on("didFinishLaunching", async () => {
      await this.getDevices();
    });
  }

  async login() {
    this.log.debug("logging in...");

    const loginIdResponse = await this.apiRequest<{ loginId: string }>(
      new URL("https://mapp.appsmb.com/v1/user/login/id/get"),
      { loginAccount: this.config["user"] },
    );
    if (loginIdResponse === InvalidSession) {
      throw new Error("invalid session getting login id");
    }

    const { loginId } = loginIdResponse;

    const hashedPassword = crypto
      .createHash("sha256")
      .update(this.config.password)
      .digest("hex");
    const password = crypto
      .createHash("sha256")
      .update(loginId + hashedPassword + Constants.AppKey)
      .digest("hex");
    const loginResponse = await this.apiRequest<{ sessionId: string }>(
      new URL("https://mapp.appsmb.com/v1/user/login"),
      { loginAccount: this.config.user, password },
    );
    if (loginResponse === InvalidSession) {
      throw new Error("invalid session getting login id");
    }
    return loginResponse.sessionId;
  }

  async getDevices() {
    const server = dgram.createSocket("udp4");
    server.addListener("error", (err) => {
      this.log.error("udp server error", err);
    });
    server.addListener("listening", () => {
      const address = server.address();
      this.log.debug(
        `discovery server listening ${address.address}:${address.port}`,
      );
      server.send(Constants.DISCOVERY_MSG, 6445, "255.255.255.255");
    });
    server.addListener("message", async (data, rinfo) => {
      this.log.debug(`discovery server got message from ${rinfo.address}`);

      const versionBytes = data.subarray(0, 2);
      if (!versionBytes.equals(Constants.HDR_8370)) {
        this.log.warn(`unsupported version - ${versionBytes}`);
        return;
      }

      if (data.subarray(8, 10).equals(Constants.HDR_ZZ)) {
        data = data.subarray(8, -16);
        this.log.warn(`INVESTIGATE ME 1`);
      }

      const decipher = crypto.createDecipheriv(
        "aes-128-ecb",
        Constants.encodeKey,
        "",
      );
      const decodedReply = decipher.update(data.subarray(40, -16));

      const deviceIdBytes = data.subarray(20, 26);
      const serialNumber = decodedReply.toString("ascii", 8, 40);
      const port = decodedReply.readUint32LE(4);
      const b = Buffer.alloc(4);
      decodedReply.copy(b, 0, 0, 4);
      b.reverse();
      const address = b.join(".");
      this.log.debug(`${address}:${port} - ${serialNumber}`);
      const ssidLength = decodedReply[40];
      const ssid = decodedReply.toString("ascii", 41, 41 + ssidLength);

      let type: number;
      if (
        decodedReply.length >= 56 + ssidLength &&
        decodedReply[55 + ssidLength] !== 0
      ) {
        type = decodedReply[55 + ssidLength];
      } else {
        type = parseInt(ssid.split("_")[1].toLowerCase(), 16);
      }

      if (type !== MideaDeviceType.AirConditioner) {
        this.log.warn(
          `Device ${deviceIdBytes.toString("hex")} is of unsupported type: ${
            MideaDeviceType[type]
          }`,
        );
        return;
      }

      const uuid = this.api.hap.uuid.generate(deviceIdBytes);
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );
      if (existingAccessory) {
        this.log.debug(
          "Restoring cached accessory",
          existingAccessory.displayName,
        );
        existingAccessory.context.deviceIdBytes = deviceIdBytes;
        existingAccessory.context.deviceType = type;
        existingAccessory.context.sn = serialNumber;
        existingAccessory.context.address = address;
        existingAccessory.context.port = port;

        this.api.updatePlatformAccessories([existingAccessory]);
        this.mideaAccessories.push(new MideaAccessory(this, existingAccessory));
      } else {
        this.log.debug(`Adding new device: ${deviceIdBytes.toString("hex")}`);
        const accessory = new this.api.platformAccessory(
          "Air Conditioner",
          uuid,
        );
        accessory.context.deviceIdBytes = deviceIdBytes;
        accessory.context.deviceType = type;
        accessory.context.sn = serialNumber;
        accessory.context.address = address;
        accessory.context.port = port;

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        this.mideaAccessories.push(new MideaAccessory(this, accessory));
      }
    });
    server.bind(() => {
      server.setBroadcast(true);
    });
  }

  async getDeviceToken(udpid: string) {
    const sessionId = await this.login();

    const response = await this.apiRequest<{
      tokenlist: { udpId: string; token: string; key: string }[];
    }>(new URL("https://mapp.appsmb.com/v1/iot/secure/getToken"), {
      udpid,
      sessionId,
    });
    if (response === InvalidSession) {
      this.log.debug("invalid session getting device token, relogging in");
      await this.login();
      return this.getDeviceToken(udpid);
    }

    return response.tokenlist.find(({ udpId }) => udpId === udpid)!;
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  async apiRequest<T>(
    url: URL,
    params: Record<string, string | number>,
  ): Promise<T | InvalidSession> {
    const form: Record<string, string | number> = {
      appId: Constants.AppId,
      clientType: Constants.ClientType,
      format: Constants.RequestFormat,
      language: Constants.Language,
      src: Constants.RequestSource,
      stamp: timestamp(),
      ...params,
    };

    const sortedQueryString = Object.keys(form)
      .sort()
      .map((key) => `${key}=${form[key]}`)
      .join("&");
    const payload = url.pathname + sortedQueryString + Constants.AppKey;
    form.sign = crypto.createHash("sha256").update(payload).digest("hex");

    const body = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      body.append(k, v.toString());
    });

    this.log.debug("apiRequest", url.pathname);
    const response = await fetch(url, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error(`response not ok: ${url.pathname}`);
    }
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${url.pathname}`);
    }
    const responseBody = await response.json();
    const errorCode = parseInt(responseBody.errorCode);
    if (errorCode) {
      if (errorCode === MideaErrorCodes.InvalidSession) {
        return InvalidSession;
      }
      throw new Error(
        `error: ${url.pathname}: ${responseBody.errorCode}, ${responseBody.msg}`,
      );
    }

    return responseBody.result;
  }
}
