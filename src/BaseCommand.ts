import * as crc8 from "./crc8";

import { MideaDeviceType } from "./enums/MideaDeviceType";

// More magic numbers. I'm sure each of these have a purpose, but none of it is documented in english. I might make an effort to google translate the SDK
// full = [170, 35, 172, 0, 0, 0, 0, 0, 3, 2, 64, 67, 70, 102, 127, 127, 0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 14, 187, 137, 169, 223, 88, 121, 170, 108, 162, 36, 170, 80, 242, 143, null];
const baseDataAC: ReadonlyArray<number> = [
  // Command Header
  170, // 0      - Sync header
  35, // 1       - Message length setting
  172, // 2      - Device type (172 for Air Conditioner)
  0, // 3        - Frame sync check (not used, 0x00)
  0, // 4        - Reserved 0x00
  0, // 4    	   - Reserved 0x00
  0, // 6		     - Message Id
  0, // 7    	   - Framework protocol version
  3, // 8        - Home appliance protocol
  2, // 9        - Message type setting identification

  // Data Start
  64, // 10      - Data request/response: Set up
  64, // 11      - power state: 0/1 + audible feedback: 64
  70, // 12      - Operational mode + Target Temperature
  102, // 13     - Fan speed 20/40/60/80/102
  127, // 14     - On timer
  127, // 15     - Off timer
  0, // 16       - Common timer
  48, // 17      - Swing mode
  0, // 18       - Turbo fan
  0, // 19       - Eco mode / Dryer / Purifier
  0, // 20       - TurboMode / Screen display / Fahrenheit

  // Padding
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,

  // 0, 0, 0, 6, 14, 187,

  // Data End
];

export default class BaseCommand {
  data: Array<number>;

  constructor(deviceType: MideaDeviceType) {
    if (deviceType !== MideaDeviceType.AirConditioner) {
      throw new Error("unsupported");
    }

    this.data = [...baseDataAC];
    this.data[0x02] = deviceType;
  }

  finalize() {
    // Add the CRC8
    this.data[this.data.length - 1] = crc8.calculate(this.data.slice(16));
    // Set the length of the command data
    this.data[0x01] = this.data.length;
    return this.data;
  }
}
