import crypto from "crypto";
import net from "net";
import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from "homebridge";
import { MideaPlatform } from "./MideaPlatform";
import { ACOperationalMode } from "./enums/ACOperationalMode";
import {
  AirConditionerSetCommand,
  AirConditionerStatusCommand,
  createLanCommand,
} from "./BaseCommand";
import {
  AC_MAX_TEMPERATURE,
  AC_MIN_TEMPERATURE,
  ENCRYPTED_MESSAGE_TYPES,
  HDR_8370,
  MessageType,
  encodeKey,
  errorData,
  iv,
  signKey,
} from "./Constants";

function convertUDPId(bytes: Uint8Array) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const first = digest.subarray(0, 16);
  const second = digest.subarray(16);
  const result = Buffer.alloc(16);
  first.forEach((v, i) => {
    result[i] = v ^ second[i];
  });
  return result.toString("hex");
}

function parseACStatus(data: Buffer) {
  let outdoor_temperature: number | null = null;
  if (data[12] !== 0 && data[12] !== 0xff) {
    outdoor_temperature = (data[12] - 50) / 2;
    const digit = 0.1 * ((data[15] & 0b11110000) >> 4);
    if (outdoor_temperature < 0) {
      outdoor_temperature -= digit;
    } else {
      outdoor_temperature += digit;
    }
  }

  let indoor_temperature: number | null = null;
  if (data[11] !== 0 && data[11] !== 0xff) {
    indoor_temperature = (data[11] - 50) / 2;
    const digit = 0.1 * (data[15] & 0b00001111);
    if (indoor_temperature < 0) {
      indoor_temperature -= digit;
    } else {
      indoor_temperature += digit;
    }
  }

  return {
    run_status: (data[1] & 0b00000001) !== 0,
    i_mode: (data[1] & 0b00000100) !== 0,
    timing_mode: (data[1] & 0b00010000) !== 0,
    quick_check: (data[1] & 0b00100000) !== 0,
    appliance_error: (data[1] & 0b10000000) !== 0,

    mode: (data[2] & 0b11100000) >> 5,
    target_temperature:
      (data[2] & 0b00001111) +
      16.0 +
      ((data[2] & 0b00010000) !== 0 ? 0.5 : 0.0),

    fan_speed: data[3] & 0b01111111,

    on_timer_set: (data[4] & 0b10000000) !== 0,
    on_timer_hours: (data[4] & 0b01111100) >> 2,
    on_timer_minutes:
      (data[4] & 0b00000011) * 15 + ((data[6] & 0b11110000) >> 4),
    off_timer_set: (data[5] & 0b10000000) !== 0,
    off_timer_hours: (data[5] & 0b01111100) >> 2,
    off_timer_minutes: (data[5] & 0b00000011) * 15 + (data[6] & 0b00001111),

    vertical_swing: (data[7] & 0b00001100) >> 2,
    horizontal_swing: data[7] & 0b00000011,

    comfort_sleep_value: data[8] & 0b00000011,
    power_saving: (data[8] & 0b00001000) !== 0,
    low_frequency_fan: (data[8] & 0b00010000) !== 0,
    turbo_fan: (data[8] & 0b00100000) !== 0,
    feel_own: (data[8] & 0b10000000) !== 0,

    comfort_sleep: (data[9] & 0b01000000) !== 0,
    natural_wind: (data[9] & 0b00000010) !== 0,
    eco: (data[9] & 0b00010000) !== 0,
    purifier: (data[9] & 0b00100000) !== 0,
    dryer: (data[9] & 0b00000100) !== 0,
    ptc: (data[9] & 0b00011000) >> 3,
    aux_heat: (data[9] & 0b00001000) !== 0,

    turbo: (data[10] & 0b00000010) !== 0,
    fahrenheit: (data[10] & 0b00000100) !== 0,
    prevent_freezing: (data[10] & 0b00100000) !== 0,

    pmv: (data[14] & 0b00001111) * 0.5 - 3.5,
    indoor_temperature,
    outdoor_temperature,
    err_code: data[16],

    humidity: data.length > 20 ? data[19] : null,
  };
}

class Security {
  tcpKey: Buffer | null = null;
  requestCount = 0;
  responseCount = 0;

  encode8370(data: Uint8Array, messageType: MessageType) {
    let header = HDR_8370;
    let size = data.length;
    let pad = 0;
    if (ENCRYPTED_MESSAGE_TYPES.includes(messageType)) {
      if ((size + 2) % 16 !== 0) {
        pad = 16 - ((size + 2) & 0b1111);
        size += pad + 32;
        data = Buffer.concat([data, crypto.randomBytes(pad)]);
      }
    }
    const twoByteBE = Buffer.alloc(2);
    twoByteBE.writeUint16BE(size);
    header = Buffer.concat([
      header,
      twoByteBE,
      new Uint8Array([0x20, (pad << 4) | messageType]),
    ]);
    twoByteBE.writeUint16BE(this.requestCount);
    data = Buffer.concat([twoByteBE, data]);
    this.requestCount++;
    if (ENCRYPTED_MESSAGE_TYPES.includes(messageType)) {
      const sign = crypto
        .createHash("sha256")
        .update(header)
        .update(data)
        .digest();
      if (!this.tcpKey) {
        throw new Error("tcpKey required");
      }
      const cipher = crypto.createCipheriv("aes-256-cbc", this.tcpKey, iv);
      cipher.setAutoPadding(false);
      data = Buffer.concat([cipher.update(data), sign]);
    }
    return Buffer.concat([header, data]);
  }

  decode8370(data: Buffer) {
    if (data.length < 6) {
      throw new Error("Message too small");
    }
    const header = data.subarray(0, 6);
    if (header[0] !== 0x83 || header[1] !== 0x70) {
      throw new Error("Message was not a v3 (8370) message");
    }
    const size = header.readUInt16BE(2) + 8;
    if (data.length < size) {
      // TODO
      throw new Error("not all data present");
    }
    if (data.length > size) {
      // TODO
      throw new Error("to much data present");
    }
    if (header[4] !== 0x20) {
      throw new Error("Byte 4 was not 0x20");
    }
    const pad = header[5] >> 4;
    const messageType = header[5] & 0xf;
    data = data.subarray(6);

    if (ENCRYPTED_MESSAGE_TYPES.includes(messageType)) {
      const signature = data.subarray(-32);
      data = data.subarray(0, -32);
      if (!this.tcpKey) {
        throw new Error("tcpKey required");
      }
      const decipher = crypto.createDecipheriv("aes-256-cbc", this.tcpKey, iv);
      decipher.setAutoPadding(false);
      data = decipher.update(data);
      if (
        !crypto
          .createHash("sha256")
          .update(Buffer.concat([header, data]))
          .digest()
          .equals(signature)
      ) {
        throw new Error("Signature does not match payload");
      }
      if (pad) {
        data = data.subarray(0, -pad);
      }
    }

    this.responseCount = data.readUInt16BE(0);
    data = data.subarray(2);

    return [data];
  }
}

class LANDevice {
  security = new Security();
  client = new net.Socket();

  private connected!: Promise<void>;

  constructor(
    private readonly address: string,
    private readonly port: number,
    private readonly log: Logger,
  ) {
    this.client.setKeepAlive(true);
    this.client.on("close", () => {
      this.log.warn("landevice close");
      this.connect();
    });
    this.connect();
  }

  connect() {
    this.log.debug("connecting");
    this.connected = new Promise((resolve) => {
      this.client.connect(this.port, this.address, () => {
        this.log.debug("connected");
        resolve();
      });
    });
  }

  async request8370(data: Uint8Array) {
    const response = await this.request(
      this.security.encode8370(data, MessageType.ENCRYPTED_REQUEST),
    );

    if (response.subarray(8, 13).equals(errorData)) {
      throw new Error("request error");
    }

    const responses = this.security.decode8370(response);
    const packets: Array<Buffer> = [];
    responses.forEach((response) => {
      if (response.length > 40 + 16) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", encodeKey, "");
        decipher.setAutoPadding(false);
        response = decipher.update(response.subarray(40, -16));
        if (response.length > 10) {
          packets.push(response);
        }
      }
    });
    return packets;
  }

  private _pendingRequest: Promise<Buffer> | null = null;
  private _queuedRequests: Array<Uint8Array> = [];

  async request(message: Uint8Array) {
    if (this._pendingRequest) {
      this._pendingRequest = this._pendingRequest.then(() =>
        this.request_(message),
      );
    } else {
      this._pendingRequest = this.request_(message);
    }
    return this._pendingRequest;
  }

  async request_(message: Uint8Array) {
    await this.connected;

    await new Promise<void>((resolve, reject) => {
      this.client.write(message, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    return await new Promise<Buffer>((resolve, reject) => {
      const handleError = (err: Error) => {
        this.log.error("landevice error", err);
        this.client.off("error", handleError);
        this.client.off("data", receive);
        reject(err);
      };
      const receive = (data: Buffer) => {
        this.client.off("error", handleError);
        this.client.off("data", receive);
        resolve(data);
      };
      this.client.on("error", handleError);
      this.client.on("data", receive);
    });
  }

  async authenticate(token: string, key: string) {
    this.log.debug("authenticating landevice");
    const byteToken = Buffer.from(token, "hex");

    const data = this.security.encode8370(
      byteToken,
      MessageType.HANDSHAKE_REQUEST,
    );
    const response = (await this.request(data)).subarray(8, 72);

    if (response.equals(errorData)) {
      throw new Error("handshake failed");
    }

    const byteKey = Buffer.from(key, "hex");
    if (response.length !== 64) {
      throw new Error("handshake response too short");
    }
    const payload = response.subarray(0, 32);
    const signature = response.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-cbc", byteKey, iv);
    decipher.setAutoPadding(false);
    const plain = decipher.update(payload);
    const hash = crypto.createHash("sha256").update(plain).digest();
    if (!hash.equals(signature)) {
      throw new Error("handshake response signature mismatch");
    }
    this.security.tcpKey = strxor(plain, Buffer.from(byteKey));
    this.log.debug("authenticated landevice");
  }
}

function strxor(plain_text: Buffer, key: Buffer) {
  const keyLen = key.length;
  const encoded = Buffer.alloc(plain_text.length);
  plain_text.forEach((k, i) => {
    encoded[i] = k ^ key[i % keyLen];
  });

  return encoded;
}

export class MideaAccessory {
  public status: ReturnType<typeof parseACStatus> | null = null;

  private device: LANDevice;

  private heaterCoolerService!: Service;
  private fanService!: Service;
  private outdoorTemperatureService!: Service;
  authenticated: boolean = false;

  createSetCommand() {
    if (!this.status) {
      throw new Error("not ready");
    }

    const cmd = new AirConditionerSetCommand();
    cmd.comfort_sleep = this.status.comfort_sleep;
    cmd.dryer = this.status.dryer;
    cmd.eco_mode = this.status.eco;
    cmd.fahrenheit = this.status.fahrenheit;
    cmd.fan_speed = this.status.fan_speed;
    cmd.horizontal_swing = this.status.horizontal_swing;
    cmd.mode = this.status.mode;
    cmd.purifier = this.status.purifier;
    cmd.running = this.status.run_status;
    cmd.temperature = this.status.target_temperature;
    cmd.turbo = this.status.turbo;
    cmd.turbo_fan = this.status.turbo_fan;
    cmd.vertical_swing = this.status.vertical_swing;
    return cmd;
  }

  constructor(
    private readonly platform: MideaPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = new LANDevice(
      this.accessory.context.address,
      this.accessory.context.port,
      this.platform.log,
    );

    this.platform.log.info(
      `Creating device: ${this.accessory.context.deviceIdBytes.toString(
        "hex",
      )}`,
    );

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Midea")
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../package.json").version,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.context.sn,
      );

    // Air Conditioner
    this.heaterCoolerService =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);
    this.heaterCoolerService.setCharacteristic(
      this.platform.Characteristic.Name,
      "Air Conditioner",
    );
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getHeaterCoolerActive.bind(this))
      .onSet((value: CharacteristicValue) => {
        this.platform.log.debug(`Triggered SET Active To: ${value}`);
        const targetPowerState =
          value === this.platform.Characteristic.Active.ACTIVE;
        this.sendUpdateToDevice((cmd) => {
          cmd.running = targetPowerState;
          if (cmd.mode === ACOperationalMode.FanOnly) {
            cmd.mode = ACOperationalMode.Auto;
          }
        });
      });
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.CurrentHeaterCoolerState.IDLE,
          this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
          this.platform.Characteristic.CurrentHeaterCoolerState.COOLING,
        ],
      })
      .onGet(this.getCurrentHeaterCoolerState.bind(this));
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(this.getTargetHeaterCoolerState.bind(this))
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET TargetHeaterCoolerState State To: ${value}`,
        );
        this.sendUpdateToDevice((cmd) => {
          switch (value) {
            case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
              cmd.mode = ACOperationalMode.Auto;
              break;
            case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
              cmd.mode = ACOperationalMode.Cooling;
              break;
            case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
              cmd.mode = ACOperationalMode.Heating;
              break;
            default:
              this.platform.log.error("ERROR targetheatercoolerstate!");
              throw new Error(`unknown target heater cooler state: ${value}`);
          }
        });
      });
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => {
        if (this.status === null) {
          this.platform.log.warn(
            "getting CurrentTemperature, status not available",
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
          );
        }
        if (this.status.indoor_temperature === null) {
          this.platform.log.warn(
            "getting CurrentTemperature, temp not available",
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST,
          );
        }
        return this.status.indoor_temperature;
      });
    this.heaterCoolerService
      .getCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
      )
      .setProps({
        minValue: AC_MIN_TEMPERATURE,
        maxValue: AC_MAX_TEMPERATURE,
        minStep: 1,
      })
      .onGet(() => {
        if (this.status === null) {
          this.platform.log.warn(
            "getting CoolingThresholdTemperature, status not available",
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
          );
        }
        return this.status.target_temperature;
      })
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET ThresholdTemperature To: ${value}˚C`,
        );
        this.sendUpdateToDevice((cmd) => {
          cmd.temperature = Number(value);
        });
      });
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.getSwingMode.bind(this))
      .onSet(this.setSwingMode.bind(this));
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .setProps({
        validValues: [
          this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
        ],
      })
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET Temperature Display Units To: ${value}`,
        );
        this.sendUpdateToDevice((cmd) => {
          cmd.fahrenheit =
            value ===
            this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
        });
      });

    this.fanService =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, "Fan");
    this.fanService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getFanActive.bind(this))
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET Fan Active To: ${value}`);
        this.sendUpdateToDevice((cmd) => {
          if (value === this.platform.Characteristic.Active.ACTIVE) {
            cmd.running = true;
            cmd.mode = ACOperationalMode.FanOnly;
          } else {
            cmd.running = false;
          }
        });
      });
    this.fanService
      .getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.getCurrentFanState.bind(this));
    this.fanService
      .getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onGet(this.getTargetFanState.bind(this))
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET TargetFanState To: ${value}`);
        if (value === this.platform.Characteristic.TargetFanState.AUTO) {
          this.sendUpdateToDevice((cmd) => {
            cmd.fan_speed = 102;
          });
        }
      });
    this.fanService
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.getSwingMode.bind(this))
      .onSet(this.setSwingMode.bind(this));
    this.fanService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      // .setProps({
      //   minValue: 0,
      //   maxValue: 100,
      //   minStep: 20,
      // })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET RotationSpeed To: ${value}`);
        if (typeof value !== "number") {
          throw new Error("value not number");
        }
        this.sendUpdateToDevice((cmd) => {
          // transform values in percent
          // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
          if (value === 0) {
            cmd.fan_speed = 102;
            cmd.mode = ACOperationalMode.Off;
          } else if (value <= 20) {
            cmd.fan_speed = 20;
          } else if (value > 20 && value <= 40) {
            cmd.fan_speed = 40;
          } else if (value > 40 && value <= 60) {
            cmd.fan_speed = 60;
          } else if (value > 60 && value <= 80) {
            cmd.fan_speed = 80;
          } else {
            cmd.fan_speed = 100;
          }
        });
      });

    this.outdoorTemperatureService =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor);
    this.outdoorTemperatureService.setCharacteristic(
      this.platform.Characteristic.Name,
      "Outdoor Temperature",
    );
    this.outdoorTemperatureService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => {
        if (!this.status || this.status.outdoor_temperature === null) {
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
          );
        }
        return this.status.outdoor_temperature;
      });
    // TODO: set a fault on this if the AC is offline

    this.poll();
  }

  private poll() {
    this.updateStatus()
      .catch((err) => {
        this.platform.log.error("update status error", err);
      })
      .then(() => setTimeout(this.poll.bind(this), 10 * 1000));
  }

  async authenticate() {
    const udpid = convertUDPId(
      this.accessory.context.deviceIdBytes.toReversed(),
    );
    const { token, key } = await this.platform.getDeviceToken(udpid);
    await this.device.authenticate(token, key);
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.authenticated = true;
  }

  private _pendingUpdateStatus: Promise<void> | null = null;

  updateStatus() {
    if (this._pendingUpdateStatus) {
      return this._pendingUpdateStatus;
    }
    this._pendingUpdateStatus = this._updateStatus().finally(() => {
      this._pendingUpdateStatus = null;
    });
    return this._pendingUpdateStatus;
  }

  async _updateStatus() {
    if (!this.authenticated) {
      await this.authenticate();
    }

    this.platform.log.debug("requesting status");
    const cmd = new AirConditionerStatusCommand();
    const lanPacket = createLanCommand(
      this.accessory.context.deviceIdBytes,
      cmd,
      signKey,
    );

    let statusResp: Buffer[];
    try {
      statusResp = await this.device.request8370(lanPacket);
    } catch (err) {
      this.platform.log.error("request status error", err);
      this.authenticated = false;
      return;
    }

    const selected = statusResp[0];
    if (selected.length < 10) {
      throw new Error("Invalid extended response");
    }
    if (![2, 3, 4, 5].includes(selected[9])) {
      throw new Error("Unknown extended response");
    }
    this.status = parseACStatus(selected.subarray(10));
    this.platform.log.debug("state", JSON.stringify(this.status));

    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.getHeaterCoolerActive(),
    );
    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeaterCoolerState,
      this.getCurrentHeaterCoolerState(),
    );
    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.TargetHeaterCoolerState,
      this.getTargetHeaterCoolerState(),
    );
    if (this.status.indoor_temperature !== null) {
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.status.indoor_temperature,
      );
    }
    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature,
      this.status.target_temperature,
    );
    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.SwingMode,
      this.getSwingMode(),
    );
    this.heaterCoolerService.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.getTemperatureDisplayUnits(),
    );

    this.fanService.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.getFanActive(),
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.CurrentFanState,
      this.getCurrentFanState(),
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.TargetFanState,
      this.getTargetFanState(),
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      this.getRotationSpeed(),
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.SwingMode,
      this.getSwingMode(),
    );

    if (this.status.outdoor_temperature !== null) {
      this.outdoorTemperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.status.outdoor_temperature,
      );
    }
  }

  async sendUpdateToDevice(update: (cmd: AirConditionerSetCommand) => void) {
    if (!this.status) {
      return;
    }

    const cmd = this.createSetCommand();
    update(cmd);
    if (Buffer.from(this.createSetCommand().data).equals(cmd.data)) {
      this.platform.log.debug("no change, not sending update");
      return;
    }

    this.platform.log.debug("sending update to device", JSON.stringify(cmd));

    const lanPacket = createLanCommand(
      this.accessory.context.deviceIdBytes,
      cmd,
      signKey,
    );
    try {
      await this.device.request8370(lanPacket);
    } catch (err) {
      this.platform.log.error("send update to device error", err);
      return;
    }

    try {
      await this.updateStatus();
    } catch (err) {
      this.platform.log.error("update after set error", err);
      return;
    }
  }

  get deviceIdBytes() {
    return this.accessory.context.deviceIdBytes;
  }

  getHeaterCoolerActive() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    return this.status.run_status &&
      this.status.mode !== ACOperationalMode.FanOnly
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  getCurrentHeaterCoolerState() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    if (!this.status.run_status) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.status.mode) {
      case ACOperationalMode.Dry:
      case ACOperationalMode.Cooling:
      case ACOperationalMode.CustomDry:
      case ACOperationalMode.Auto:
        if (
          this.status.indoor_temperature &&
          this.status.indoor_temperature >= this.status.target_temperature
        ) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        }
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case ACOperationalMode.Heating:
        this.platform.log.warn("unexpectedly in heating state");
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case ACOperationalMode.FanOnly:
      case ACOperationalMode.Off:
        return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
      default:
        throw new Error("unexpected mode");
    }
  }

  getTargetHeaterCoolerState() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    switch (this.status.mode) {
      case ACOperationalMode.FanOnly:
      case ACOperationalMode.Cooling:
        return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      case ACOperationalMode.Heating:
        this.platform.log.warn("unexpectedly in heating state");
        return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
      case ACOperationalMode.Dry:
      case ACOperationalMode.Auto:
      case ACOperationalMode.CustomDry:
      case ACOperationalMode.Off:
        return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
      default:
        throw new Error("unexpected mode");
    }
  }

  getRotationSpeed() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
    // New Midea devices has slider between 1%-100%
    // convert to good usable slider in homekit in percent
    switch (this.status.fan_speed) {
      case 0:
      case 20:
      case 40:
      case 60:
      case 80:
      case 100:
        return this.status.fan_speed;
      case 101:
      case 102:
        // TODO undefined, auto
        return 50;
      default:
        throw new Error(`unknown midea fan speed ${this.status.fan_speed}`);
    }
  }

  getTemperatureDisplayUnits() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    return this.status.fahrenheit
      ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  setSwingMode(value: CharacteristicValue) {
    this.platform.log.debug(`Triggered SET SwingMode To: ${value}`);
    this.sendUpdateToDevice((cmd) => {
      // convert this.swingMode to a 0/1
      cmd.vertical_swing = value ? 1 : 0;
    });
  }

  getSwingMode() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    return this.status.vertical_swing !== 0
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  getFanActive() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    if (!this.status.run_status) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.status.run_status &&
      this.status.mode === ACOperationalMode.FanOnly
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  getCurrentFanState() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    if (!this.status.run_status) {
      return this.platform.Characteristic.CurrentFanState.INACTIVE;
    }
    switch (this.status.mode) {
      case ACOperationalMode.FanOnly:
        return this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
      default:
        return this.platform.Characteristic.CurrentFanState.IDLE;
    }
  }

  getTargetFanState() {
    if (this.status === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    return this.status.fan_speed === 102 || this.status.fan_speed === 101
      ? this.platform.Characteristic.TargetFanState.AUTO
      : this.platform.Characteristic.TargetFanState.MANUAL;
  }
}
