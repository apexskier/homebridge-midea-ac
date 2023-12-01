import * as crc8 from "./crc8";
import crypto from "crypto";

import { MideaDeviceType } from "./enums/MideaDeviceType";

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
