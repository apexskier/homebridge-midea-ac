import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import axios, { AxiosInstance } from "axios";

import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import tough from "tough-cookie";
import qs from "querystring";
import * as Utils from "./Utils";
import * as Constants from "./Constants";
import PacketBuilder from "./PacketBuilder";

import ACSetCommand from "./commands/ACSetCommand";

import ACApplianceResponse from "./responses/ACApplianceResponse";

import { MideaAccessory } from "./MideaAccessory";
import { MideaDeviceType } from "./enums/MideaDeviceType";
import { timestamp } from "./timestamp";
import { MideaErrorCodes } from "./enums/MideaErrorCodes";

// STATUS ONLY OR POWER ON/OFF HEADER
const ac_data_header = [
  90, 90, 1, 16, 89, 0, 32, 0, 80, 0, 0, 0, 169, 65, 48, 9, 14, 5, 20, 20, 213,
  50, 1, 0, 0, 17, 0, 0, 0, 4, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0,
];

// const dh_data_header = [
//   90, 90, 1, 0, 89, 0, 32, 0, 1, 0, 0, 0, 39, 36, 17, 9, 13, 10, 18, 20, 218,
//   73, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
// ];

export class MideaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;
  private jar: tough.CookieJar;
  updateInterval: NodeJS.Timer | null = null;
  reauthInterval: NodeJS.Timer | null = null;
  accessToken: string = "";
  sessionId: string = "";
  userId: string = "";
  dataKey: string = "";
  apiClient: AxiosInstance;
  public readonly accessories: PlatformAccessory[] = [];
  mideaAccessories: MideaAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    axiosCookieJarSupport(axios);
    this.jar = new tough.CookieJar();
    this.apiClient = axios.create({
      baseURL: "https://mapp.appsmb.com/v1",
      headers: {
        "User-Agent": Constants.UserAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      jar: this.jar,
    });
    this.log = log;
    this.config = config;
    api.on("didFinishLaunching", async () => {
      try {
        await this.login();
        try {
          await this.getDevices();
        } catch (err) {
          this.log.error("failed to get devices", err);
        }
        this.poll();
      } catch (err) {
        this.log.error("failed to log in", err);
      }
    });
  }

  private poll() {
    this.updateValues()
      .catch((err) => {
        this.log.error(err);
      })
      .finally(() => {
        setTimeout(() => {
          this.poll();
        }, 10 * 1000);
      });
  }

  async apiRequest(url: string, data: Record<string, string>) {
    const form: Record<string, string> = {
      src: Constants.RequestSource,
      format: Constants.RequestFormat,
      stamp: timestamp(),
      language: Constants.Language,

      ...data,
    };
    form.sign = Utils.getSign(url, form, Constants.AppKey);
    return await this.apiClient.post(url, qs.stringify(form));
  }

  async login() {
    this.log.debug("Logging in...");

    const loginData = {
      clientType: Constants.ClientType,
      appId: Constants.AppId,
      reqid: Utils.reqId,
    };

    try {
      const response = await this.apiRequest("/user/login/id/get", {
        ...loginData,
        loginAccount: this.config["user"],
      });
      if (response.data?.errorCode && response.data.errorCode !== "0") {
        this.log.debug(`Login request failed with error: ${response.data.msg}`);
      } else {
        const loginId: string = response.data.result.loginId;
        const password: string = Utils.getSignPassword(
          loginId,
          this.config.password,
          Constants.AppKey,
        );
        try {
          const loginResponse = await this.apiRequest("/user/login", {
            ...loginData,
            loginAccount: this.config["user"],
            password: password,
          });
          if (
            loginResponse.data.errorCode &&
            loginResponse.data.errorCode !== "0"
          ) {
            this.log.debug(
              `Login request 2 returned error: ${loginResponse.data.msg}`,
            );
          } else {
            this.accessToken = loginResponse.data.result.accessToken;
            this.sessionId = loginResponse.data.result.sessionId;
            this.userId = loginResponse.data.result.userId;
            this.dataKey = Utils.generateDataKey(
              this.accessToken,
              Constants.AppKey,
            );
          }
        } catch (err) {
          this.log.debug(`Login request 2 failed with: ${err}`);
          throw err;
        }
      }
    } catch (err) {
      this.log.debug(`Login request failed with: ${err}`);
      throw err;
    }
  }

  async getDevices() {
    this.log.debug("fetching devices");

    const response = await this.apiRequest("/appliance/user/list/get", {
      sessionId: this.sessionId,
    });
    if (response.data.errorCode && response.data.errorCode !== "0") {
      throw new Error(`getUserList returned error: ${response.data.msg}`);
    }
    if (!response.data.result?.list) {
      throw new Error("getUserList invalid response");
    }
    response.data.result.list.forEach((currentElement) => {
      if (parseInt(currentElement.type) !== MideaDeviceType.AirConditioner) {
        this.log.warn(
          `Device: ${currentElement.name} is of unsupported type: ${
            MideaDeviceType[parseInt(currentElement.type)]
          }`,
        );
        return;
      }

      const uuid = this.api.hap.uuid.generate(currentElement.id);
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );
      if (existingAccessory) {
        this.log.debug(
          "Restoring cached accessory",
          existingAccessory.displayName,
        );
        existingAccessory.context.deviceId = currentElement.id;
        existingAccessory.context.deviceType = parseInt(currentElement.type);
        existingAccessory.context.name = currentElement.name;
        existingAccessory.context.userId = currentElement.userId;
        existingAccessory.context.modelNumber = currentElement.modelNumber;
        existingAccessory.context.sn = Utils.decryptAesString(
          currentElement.sn,
          this.dataKey,
        );
        this.log.debug(`Model Number:${existingAccessory.context.modelNumber}`);
        this.log.debug(`Serial Number:${existingAccessory.context.sn}`);

        this.api.updatePlatformAccessories([existingAccessory]);

        this.mideaAccessories.push(new MideaAccessory(this, existingAccessory));
      } else {
        this.log.debug(`Adding new device: ${currentElement.name}`);
        const accessory = new this.api.platformAccessory(
          currentElement.name,
          uuid,
        );
        accessory.context.deviceId = currentElement.id;
        accessory.context.deviceType = parseInt(currentElement.type);
        accessory.context.name = currentElement.name;
        accessory.context.userId = currentElement.userId;
        accessory.context.modelNumber = currentElement.modelNumber;
        accessory.context.sn = Utils.decryptAesString(
          currentElement.sn,
          this.dataKey,
        );
        this.log.debug(`Model Number:${accessory.context.modelNumber}`);
        this.log.debug(`Serial Number:${accessory.context.sn}`);

        this.api.registerPlatformAccessories(
          "homebridge-midea-air",
          "midea-air",
          [accessory],
        );
        this.mideaAccessories.push(new MideaAccessory(this, accessory));
      }
    });
    this.log.debug("done fetching devices");
  }

  async sendCommand(
    device: MideaAccessory,
    data: ReadonlyArray<number>,
    intent: string,
    firstTry = true,
  ) {
    try {
      const response = await this.apiRequest("/appliance/transparent/send", {
        applianceId: device.deviceId,
        funId: "0000", // maybe it is also "FC02"
        order: Utils.encryptAes(Utils.encode(data), this.dataKey),
        sessionId: this.sessionId,
      });
      if (response.data.errorCode && response.data.errorCode !== "0") {
        switch (parseInt(response.data.errorCode)) {
          case MideaErrorCodes.DeviceUnreachable:
            // device is offline, don't error, since we can't do anything
            this.log.warn(`${device.name} (${device.deviceId}) is offline`);
            return;
          case MideaErrorCodes.InvalidSession:
            if (firstTry) {
              this.log.debug(`Logged out, logging and and retrying, ${intent}`);
              await this.login();
              return this.sendCommand(device, data, intent, false);
            }
        }
        throw new Error(
          `Send command to: ${device.name} (${device.deviceId}) ${intent} returned error: ${response.data.msg} (${response.data.errorCode})`,
        );
      }

      this.log.debug(
        `Send command to: ${device.name} (${device.deviceId}) ${intent} success!`,
      );
      const applianceResponse = new ACApplianceResponse(
        Utils.decode(
          Utils.decryptAes(response.data.result.reply, this.dataKey),
        ),
      );

      device.targetTemperature = applianceResponse.targetTemperature;
      device.indoorTemperature = applianceResponse.indoorTemperature;
      device.outdoorTemperature = applianceResponse.outdoorTemperature;
      device.swingMode = applianceResponse.swingMode;
      device.useFahrenheit = applianceResponse.useFahrenheit;
      device.turboFan = applianceResponse.turboFan;
      device.ecoMode = applianceResponse.ecoMode;
      device.turboMode = applianceResponse.turboMode;
      device.comfortSleep = applianceResponse.comfortSleep;
      device.dryer = applianceResponse.dryer;
      device.purifier = applianceResponse.purifier;

      this.log.debug(`Target Temperature: ${device.targetTemperature}˚C`);
      this.log.debug(`Indoor Temperature: ${device.indoorTemperature}˚C`);
      this.log.debug(`Outdoor Temperature: ${device.outdoorTemperature}˚C`);
      this.log.debug(`Swing Mode set to: ${device.swingMode}`);
      this.log.debug(`Fahrenheit set to: ${device.useFahrenheit}`);
      this.log.debug(`Turbo Fan set to: ${device.turboFan}`);
      this.log.debug(`Eco Mode set to: ${device.ecoMode}`);
      this.log.debug(`Turbo Mode set to: ${device.turboMode}`);
      this.log.debug(`Comfort Sleep set to: ${device.comfortSleep}`);
      this.log.debug(`Dryer set to: ${device.dryer}`);
      this.log.debug(`Purifier set to: ${device.purifier}`);

      // Common
      device.powerState = applianceResponse.powerState;
      device.operationalMode = applianceResponse.operationalMode;
      device.fanSpeed = applianceResponse.fanSpeed;

      this.log.debug(`Power State set to: ${device.powerState}`);
      this.log.debug(`Operational Mode set to: ${device.operationalMode}`);
      this.log.debug(`Fan Speed set to: ${device.fanSpeed}`);

      // this.log.debug(
      //   `Full data: ${Utils.formatResponse(applianceResponse.data)}`
      // );
    } catch (err) {
      this.log.error(`SendCommand (${intent}) request failed: ${err}`);
      throw err;
    }
  }

  async updateValues() {
    for (const accessory of this.accessories) {
      this.log.debug(
        `Updating accessory: ${accessory.context.name} (${accessory.context.deviceId})`,
      );
      const mideaAccessory = this.mideaAccessories.find(
        (ma) => ma.deviceId === accessory.context.deviceId,
      );
      if (!mideaAccessory) {
        this.log.warn(
          `Could not find accessory with id: ${accessory.context.deviceId}`,
        );
        return;
      }

      // Setup the data payload based on deviceType
      await this.sendCommand(
        mideaAccessory,
        ac_data_header.concat(Constants.UpdateCommand_AirCon),
        "[updateValues]",
      );
    }
  }

  async sendUpdateToDevice(device: MideaAccessory) {
    const command = new ACSetCommand();
    command.targetTemperature = device.targetTemperature;
    command.swingMode = device.swingMode;
    command.useFahrenheit = device.useFahrenheit;
    command.ecoMode = device.ecoMode;
    command.screenDisplay = device.screenDisplay;
    command.powerState = device.powerState;
    command.audibleFeedback = device.audibleFeedback;
    command.operationalMode = device.operationalMode;
    command.fanSpeed = device.fanSpeed;
    // operational mode for workaround with fan only mode on device
    const pktBuilder = new PacketBuilder();
    pktBuilder.command = command;
    const data = pktBuilder.finalize();
    this.log.debug(
      `[sendUpdateToDevice] Header + Command: ${JSON.stringify(data)}`,
    );

    await this.sendCommand(device, data, "[sendUpdateToDevice]");

    // after sending, update because sometimes the api hangs
    this.updateValues();
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }
}
