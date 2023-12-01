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
import { baseForm, getSign, getSignPassword } from "./Utils";

export class MideaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;
  updateInterval: NodeJS.Timer | null = null;
  reauthInterval: NodeJS.Timer | null = null;
  accessToken: string = "";
  sessionId: string = "";
  userId: string = "";
  dataKey: string = "";
  public readonly accessories: PlatformAccessory[] = [];
  mideaAccessories: MideaAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.log = log;
    this.config = config;
    api.on("didFinishLaunching", async () => {
      await this.login();
      await this.getDevices();
    });
  }

  async login() {
    this.log.debug("Logging in...");

    let form: Record<string, string | number> = {
      ...baseForm(),
      loginAccount: this.config["user"],
    };
    let url = new URL("https://mapp.appsmb.com/v1/user/login/id/get");
    form.sign = getSign(url.pathname, form, Constants.AppKey);

    let body = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      body.append(k, v.toString());
    });
    let response = await fetch(url, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error("login id response not ok");
    }
    if (response.status !== 200) {
      throw new Error("unexpected login id status");
    }
    let responseBody = await response.json();
    if (responseBody.errorCode !== "0") {
      throw new Error(
        `getToken error: ${responseBody.errorCode}, ${responseBody.msg}`
      );
    }

    const loginId = responseBody.result.loginId;
    const password = getSignPassword(
      loginId,
      this.config.password,
      Constants.AppKey
    );
    form = {
      ...baseForm(),
      loginAccount: this.config.user,
      password,
    };
    url = new URL("https://mapp.appsmb.com/v1/user/login");
    form.sign = getSign(url.pathname, form, Constants.AppKey);

    body = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      body.append(k, v.toString());
    });
    response = await fetch(url, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error("login response not ok");
    }
    if (response.status !== 200) {
      throw new Error("unexpected getToken status");
    }
    responseBody = await response.json();
    if (responseBody.errorCode !== "0") {
      throw new Error(
        `getToken error: ${responseBody.errorCode}, ${responseBody.msg}`
      );
    }

    this.sessionId = responseBody.result.sessionId;
  }

  async getDevices() {
    const server = dgram.createSocket("udp4");
    server.on("error", (err) => {
      this.log.error("udp server error", err);
    });
    server.on("listening", () => {
      const address = server.address();
      this.log.debug(
        `discovery server listening ${address.address}:${address.port}`
      );
      server.send(Constants.DISCOVERY_MSG, 6445, "255.255.255.255");
    });
    server.on("message", async (data, rinfo) => {
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
        ""
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
          }`
        );
        return;
      }

      const uuid = this.api.hap.uuid.generate(deviceIdBytes);
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid
      );
      if (existingAccessory) {
        this.log.debug(
          "Restoring cached accessory",
          existingAccessory.displayName
        );
        existingAccessory.context.deviceIdBytes = deviceIdBytes;
        existingAccessory.context.deviceType = type;
        // existingAccessory.context.name = "TODO";
        // existingAccessory.context.userId = currentElement.userId;
        // existingAccessory.context.modelNumber = currentElement.modelNumber;
        existingAccessory.context.sn = serialNumber;
        existingAccessory.context.address = address;
        existingAccessory.context.port = port;
        // this.log.debug(`Model Number:${existingAccessory.context.modelNumber}`);
        this.log.debug(`Serial Number:${existingAccessory.context.sn}`);

        this.api.updatePlatformAccessories([existingAccessory]);

        this.mideaAccessories.push(new MideaAccessory(this, existingAccessory));
      } else {
        this.log.debug(`Adding new device: ${deviceIdBytes.toString("hex")}`);
        const accessory = new this.api.platformAccessory("TODO", uuid);
        accessory.context.deviceIdBytes = deviceIdBytes;
        accessory.context.deviceType = type;
        // accessory.context.name = currentElement.name;
        // accessory.context.userId = currentElement.userId;
        // accessory.context.modelNumber = currentElement.modelNumber;
        accessory.context.sn = serialNumber;
        accessory.context.address = address;
        accessory.context.port = port;
        // this.log.debug(`Model Number:${accessory.context.modelNumber}`);
        this.log.debug(`Serial Number:${accessory.context.sn}`);

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

  // async sendCommand(
  //   device: MideaAccessory,
  //   data: ReadonlyArray<number>,
  //   intent: string,
  //   firstTry = true
  // ) {
  //   try {
  //     const response = await this.apiRequest("/appliance/transparent/send", {
  //       applianceId: device.deviceId,
  //       funId: "0000", // maybe it is also "FC02"
  //       order: Utils.encryptAes(Utils.encode(data), this.dataKey),
  //       sessionId: this.sessionId,
  //     });
  //     if (response.data.errorCode && response.data.errorCode !== "0") {
  //       switch (parseInt(response.data.errorCode)) {
  //         case MideaErrorCodes.DeviceUnreachable:
  //           // device is offline, don't error, since we can't do anything
  //           this.log.warn(`${device.name} (${device.deviceId}) is offline`);
  //           return;
  //         case MideaErrorCodes.InvalidSession:
  //           if (firstTry) {
  //             this.log.debug(`Logged out, logging and and retrying, ${intent}`);
  //             await this.login();
  //             return this.sendCommand(device, data, intent, false);
  //           }
  //       }
  //       throw new Error(
  //         `Send command to: ${device.name} (${device.deviceId}) ${intent} returned error: ${response.data.msg} (${response.data.errorCode})`
  //       );
  //     }

  //     this.log.debug(
  //       `Send command to: ${device.name} (${device.deviceId}) ${intent} success!`
  //     );
  //     const applianceResponse = new ACApplianceResponse(
  //       Utils.decode(Utils.decryptAes(response.data.result.reply, this.dataKey))
  //     );

  //     device.targetTemperature = applianceResponse.targetTemperature;
  //     device.indoorTemperature = applianceResponse.indoorTemperature;
  //     device.outdoorTemperature = applianceResponse.outdoorTemperature;
  //     device.swingMode = applianceResponse.swingMode;
  //     device.useFahrenheit = applianceResponse.useFahrenheit;
  //     device.turboFan = applianceResponse.turboFan;
  //     device.ecoMode = applianceResponse.ecoMode;
  //     device.turboMode = applianceResponse.turboMode;
  //     device.comfortSleep = applianceResponse.comfortSleep;
  //     device.dryer = applianceResponse.dryer;
  //     device.purifier = applianceResponse.purifier;

  //     this.log.debug(`Target Temperature: ${device.targetTemperature}˚C`);
  //     this.log.debug(`Indoor Temperature: ${device.indoorTemperature}˚C`);
  //     this.log.debug(`Outdoor Temperature: ${device.outdoorTemperature}˚C`);
  //     this.log.debug(`Swing Mode set to: ${device.swingMode}`);
  //     this.log.debug(`Fahrenheit set to: ${device.useFahrenheit}`);
  //     this.log.debug(`Turbo Fan set to: ${device.turboFan}`);
  //     this.log.debug(`Eco Mode set to: ${device.ecoMode}`);
  //     this.log.debug(`Turbo Mode set to: ${device.turboMode}`);
  //     this.log.debug(`Comfort Sleep set to: ${device.comfortSleep}`);
  //     this.log.debug(`Dryer set to: ${device.dryer}`);
  //     this.log.debug(`Purifier set to: ${device.purifier}`);

  //     // Common
  //     device.powerState = applianceResponse.powerState;
  //     device.operationalMode = applianceResponse.operationalMode;
  //     device.fanSpeed = applianceResponse.fanSpeed;

  //     this.log.debug(`Power State set to: ${device.powerState}`);
  //     this.log.debug(`Operational Mode set to: ${device.operationalMode}`);
  //     this.log.debug(`Fan Speed set to: ${device.fanSpeed}`);

  //     // this.log.debug(
  //     //   `Full data: ${Utils.formatResponse(applianceResponse.data)}`
  //     // );
  //   } catch (err) {
  //     this.log.error(`SendCommand (${intent}) request failed: ${err}`);
  //     throw err;
  //   }
  // }

  async sendUpdateToDevice(device: MideaAccessory) {
    // TODO

    // after sending, update because sometimes the api hangs
    device.updateStatus();
  }

  async getDeviceToken(udpid: string) {
    const form: Record<string, string | number> = {
      ...baseForm(),
      udpid,
      sessionId: this.sessionId,
    };
    const url = new URL("https://mapp.appsmb.com/v1/iot/secure/getToken");
    form.sign = getSign(url.pathname, form, Constants.AppKey);
    const body = new FormData();
    Object.entries(form).forEach(([k, v]) => {
      body.append(k, v.toString());
    });
    const response = await fetch(url, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      throw new Error("getToken response not ok");
    }
    if (response.status !== 200) {
      throw new Error("unexpected getToken status");
    }
    const responseBody = await response.json();
    if (responseBody.errorCode && parseInt(responseBody.errorCode)) {
      throw new Error(
        `getToken error: ${responseBody.errorCode}, ${responseBody.msg}`
      );
    }
    const { token, key } = responseBody.result.tokenlist.find(
      ({ udpId }) => udpId === udpid
    );
    return { token, key };
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }
}
