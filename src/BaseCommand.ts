import * as crc8 from "./crc8";
import crypto from "crypto";

import { MideaDeviceType } from "./enums/MideaDeviceType";
import { ACOperationalMode } from "./enums/ACOperationalMode";
import { AC_MAX_TEMPERATURE, AC_MIN_TEMPERATURE } from "./Constants";

export abstract class BaseCommand {
  constructor(protected data: Uint8Array) {}

  finalize() {
    // Add the CRC8
    this.data[this.data.length - 2] = crc8.calculate(
      this.data.subarray(10, -2)
    );
    // Add message check code
    this.data[this.data.length - 1] =
      (~this.data.subarray(1, -1).reduce((p, c) => p + c, 0) + 1) & 0b11111111;
    return this.data;
  }
}

export class DeviceCapabilitiesCommand extends BaseCommand {
  constructor(deviceType: MideaDeviceType) {
    super(
      new Uint8Array([
        0xaa,
        0x0e,
        deviceType,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x03,
        0x03,
        0xb5,
        0x01,
        0x00,
        0x00,
        0x00,
      ])
    );
  }
}

class MideaSequenceCommand extends BaseCommand {
  // Each command has unique command id. We generate it as single byte
  // sequence with roll-over
  private static sequence = 0;

  static resetSequence(value = 0) {
    MideaSequenceCommand.sequence = value;
  }

  constructor(
    data: Uint8Array,
    private readonly sequenceIndex: number = 30
  ) {
    super(data);
  }

  finalize() {
    // TODO: thread locking?
    MideaSequenceCommand.sequence =
      (MideaSequenceCommand.sequence + 1) & 0b11111111;
    this.data[this.sequenceIndex] = MideaSequenceCommand.sequence;
    return super.finalize();
  }
}

export class AirConditionerStatusCommand extends MideaSequenceCommand {
  constructor() {
    super(
      new Uint8Array([
        // 0 header
        0xaa,
        // 1 command length: N+10
        0x20,
        // 2 appliance type 0xAC - airconditioning, 0xA1 - dehumidifier
        0xac,
        // 3 Frame SYN CheckSum
        0x00,
        // 4-5 Reserved
        0x00, 0x00,
        // 6 Message ID
        0x00,
        // 7 Frame Protocol Version
        0x00,
        // 8 Device Protocol Version
        0x00,
        // 9 Message Type: querying is 0x03; setting is 0x02
        0x03,
        // Byte0 - Data request/response type:
        // 0x41 - check status;
        // 0x40 - Set up
        0x41,
        // Byte1
        0x81,
        // Byte2 - operational_mode
        0x00,
        // Byte3
        0xff,
        // Byte4
        0x03,
        // Byte5
        0xff,
        // Byte6
        0x00,
        // Byte7 - Room Temperature Request:
        // 0x02 - indoor_temperature,
        // 0x03 - outdoor_temperature
        // when set, this is swing_mode
        0x02,
        // Byte 8
        0x00,
        // Byte 9
        0x00,
        // Byte 10
        0x00,
        // Byte 11
        0x00,
        // Byte 12
        0x00,
        // Byte 13
        0x00,
        // Byte 14
        0x00,
        // Byte 15
        0x00,
        // Byte 16
        0x00,
        // Byte 17
        0x00,
        // Byte 18
        0x00,
        // Byte 19
        0x00,
        // Byte 20
        // Message ID
        0x00,
        // CRC8
        0x00,
        // Checksum
        0x00,
      ])
    );
  }
}

export function createLanCommand(
  applianceID: Uint8Array,
  command: BaseCommand,
  signKey: Uint8Array
) {
  const now = new Date();
  // Init the packet with the header data.
  let data = Buffer.from(
    new Uint8Array([
      // 2 bytes - Static Header
      0x5a,
      0x5a,
      // 2 bytes - Message Type
      0x01,
      0x11,
      // 2 bytes - Packet Length
      0x00,
      0x00,
      // 2 bytes
      0x20,
      0x00,
      // 4 bytes - MessageId
      0x00,
      0x00,
      0x00,
      0x00,
      // 8 bytes - Date&Time
      0, // now.getUTCMilliseconds() / 10,
      0, // now.getUTCSeconds(),
      0, // now.getUTCMinutes(),
      0, // now.getUTCHours(),
      0, // now.getUTCDate(),
      0, // now.getUTCMonth(),
      0, // now.getUTCFullYear() % 100,
      0, // Math.trunc(now.getUTCFullYear() / 100),
      // 8 bytes - Device ID
      ...applianceID,
      0x00, // id_bytes[6],
      0x00, // id_bytes[7],
      // 12 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ])
  );

  // local packets are encrypted
  const encodeKey = crypto.createHash("md5").update(signKey).digest();
  const cipher = crypto.createCipheriv("aes-128-ecb", encodeKey, "");
  const encrypted = Buffer.concat([
    cipher.update(command.finalize()),
    cipher.final(),
  ]);

  data = Buffer.concat([data, encrypted]);

  // packet length
  data.writeUInt16LE(data.length + 16, 4);

  // checksum
  const md5fingerprint = crypto
    .createHash("md5")
    .update(data)
    .update(signKey)
    .digest();

  return Buffer.concat([data, md5fingerprint]);
}

export class AirConditionerSetCommand extends MideaSequenceCommand {
  constructor() {
    super(
      new Uint8Array([
        // Sync header
        0xaa,
        // Length
        0x23,
        // Device type: Air conditioner
        MideaDeviceType.AirConditioner,
        // Frame synchronization check
        0x00,
        // Reserved
        0x00,
        0x00,
        // Message id
        0x00,
        // Framework protocol
        0x00,
        // Home appliance protocol
        0x00,
        // Message Type: querying is 0x03; control is 0x02
        0x02,
        // Payload
        // Data request/response type:
        // 0x41 - check status
        // 0x40 - write
        0x40,
        // Flags: On bit0 (byte 11)
        0x00,
        // Mode (byte 12)
        0x00,
        // Fan (byte 13)
        0x00,
        0x00,
        0x00,
        0x00,
        // ? (byte 17)
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        // 3 more?
        0x00,
        0x00,
        0x00,
      ])
    );
  }

  get running() {
    return (this.data[11] & 0b00000001) != 0;
  }

  set running(state: boolean) {
    this.data[11] &= ~0b00000001; // Clear the power bit
    this.data[11] |= state ? 0b00000001 : 0;
  }

  get beep_prompt() {
    return (this.data[11] & 0b01000000) != 0;
  }

  set beep_prompt(state: boolean) {
    this.data[11] &= ~0b01000000; // Clear the beep prompt bit
    this.data[11] |= state ? 0b01000000 : 0;
  }

  get mode() {
    return (this.data[12] & 0b11100000) >> 5;
  }

  set mode(mode: ACOperationalMode) {
    this.data[12] &= ~0b11100000; // Clear the mode bits
    this.data[12] |= (mode & 0b111) << 5;
  }

  get temperature() {
    // Current target A/C temperature
    return (this.data[12] & 0b00001111) + 16 + this.temperature_decimal;
  }

  set temperature(temperature: number) {
    this.data[12] &= ~0b00001111; // Clear the temperature bits
    if (temperature < AC_MIN_TEMPERATURE || temperature > AC_MAX_TEMPERATURE) {
      this.temperature_decimal = 0;
    } else {
      const temperature_int = Math.trunc(temperature);
      this.temperature_decimal = temperature - temperature_int;
      this.data[12] |= Math.trunc(temperature_int) & 0b00001111;
    }
  }

  get temperature_decimal() {
    // Current target A/C temperature (decimals)
    return (this.data[12] & 0b00010000) != 0 ? 0.5 : 0;
  }

  set temperature_decimal(digit: number) {
    this.data[12] &= ~0b00010000; // Clear the mode bits
    if (digit === 0.5) {
      this.data[12] |= 0b00010000;
    }
  }

  get fan_speed() {
    return this.data[13] & 0b01111111;
  }

  set fan_speed(speed: number) {
    this.data[13] &= ~0b01111111; // Clear the fan speed part
    this.data[13] |= speed & 0b01111111;
  }

  get horizontal_swing() {
    return (this.data[17] & 0x0011) >> 2;
  }

  set horizontal_swing(mode: number) {
    this.data[17] &= ~0b0011; // Clear the mode bit
    this.data[17] |= mode ? 0b1110011 : 0;
  }

  get vertical_swing() {
    return (this.data[17] & 0b1100) >> 2;
  }

  set vertical_swing(mode: number) {
    this.data[17] &= ~0b1100; // Clear the mode bit
    this.data[17] |= mode ? 0b111100 : 0;
  }

  get turbo_fan() {
    return (this.data[18] & 0b00100000) != 0;
  }

  set turbo_fan(turbo_fan: boolean) {
    this.data[18] &= ~0b001000000;
    this.data[18] |= turbo_fan ? 0b00100000 : 0;
  }

  get dryer() {
    return (this.data[19] & 0b00000100) != 0;
  }

  set dryer(dryer: boolean) {
    this.data[19] &= ~0b00000100;
    this.data[19] |= dryer ? 0b00000100 : 0;
  }

  get purifier() {
    return (this.data[19] & 0b00100000) != 0;
  }

  set purifier(purifier: boolean) {
    this.data[19] &= ~0b00100000;
    this.data[19] |= purifier ? 0b00100000 : 0;
  }

  get eco_mode() {
    return (this.data[19] & 0b10000000) !== 0;
  }

  set eco_mode(eco_mode_enabled: boolean) {
    this.data[19] &= ~0b10000000;
    this.data[19] |= eco_mode_enabled ? 0b10000000 : 0;
  }

  get comfort_sleep() {
    return (this.data[20] & 0b10000000) != 0;
  }

  set comfort_sleep(state: boolean) {
    this.data[20] &= ~0b10000000; // Clear the comfort sleep switch
    this.data[20] |= state ? 0b10000000 : 0;
    this.data[18] &= ~0b00000011; // Clear the comfort value
    this.data[18] |= state ? 0b00000011 : 0;
  }

  get fahrenheit() {
    // Display degrees Fahrenheit (only impacts device display)
    return (this.data[20] & 0b00000100) !== 0;
  }

  set fahrenheit(fahrenheit: boolean) {
    this.data[20] &= ~0b00000100;
    this.data[20] |= fahrenheit ? 0b00000100 : 0;
  }

  get turbo() {
    return (this.data[20] & 0b00000010) != 0;
  }

  set turbo(turbo: boolean) {
    this.data[20] &= ~0b00000010;
    this.data[20] |= turbo ? 0b00000010 : 0;
  }

  get screen() {
    return (this.data[20] & 0b00010000) !== 0;
  }

  set screen(screen: boolean) {
    this.data[20] &= ~0b00010000;
    this.data[20] |= screen ? 0b00010000 : 0;
  }
}
