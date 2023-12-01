import * as Constants from "./Constants";
import crypto from "crypto";
import net from "net";
import dgram from "node:dgram";
import { getSign, getSignPassword } from "./Utils";
import {
  AirConditionerSetCommand,
  AirConditionerStatusCommand,
  BaseCommand,
  DeviceCapabilitiesCommand,
  createLanCommand,
} from "./BaseCommand";
import { timestamp } from "./timestamp";

const server = dgram.createSocket("udp4");

const iv = Buffer.alloc(16).fill(0);

const signKey = new TextEncoder().encode(
  "xhdiwjnchekd4d512chdjx5d8e4c394D2D7S"
);

const encodeKey = crypto.createHash("md5").update(signKey).digest();

const DISCOVERY_MSG = new Uint8Array([
  0x5a, 0x5a, 0x01, 0x11, 0x48, 0x00, 0x92, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x7f, 0x75, 0xbd, 0x6b, 0x3e, 0x4f, 0x8b, 0x76, 0x2e, 0x84, 0x9c, 0x6e,
  0x57, 0x8d, 0x65, 0x90, 0x03, 0x6e, 0x9d, 0x43, 0x42, 0xa5, 0x0f, 0x1f, 0x56,
  0x9e, 0xb8, 0xec, 0x91, 0x8e, 0x92, 0xe5,
]);

const HDR_8370 = Buffer.from([0x83, 0x70]);
const HDR_ZZ = Buffer.from([0x5a, 0x5a]);

function buf2hex(buffer) {
  // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
    .map((x) => "\\x" + x.toString(16).padStart(2, "0"))
    .join(" ");
}

server.on("message", async (data, rinfo) => {
  console.debug(`discovery server got message from ${rinfo.address}`);

  const versionBytes = data.subarray(0, 2);
  let version;
  if (versionBytes.equals(HDR_ZZ)) {
    version = 2;
  } else if (versionBytes.equals(HDR_8370)) {
    version = 3;
  } else {
    version = 0;
  }
  console.log(version, ":", buf2hex(versionBytes));

  if (data.subarray(8, 10).equals(HDR_ZZ)) {
    data = data.subarray(8, -16);
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", encodeKey, "");
  const decodedReply = decipher.update(data.subarray(40, -16));

  const deviceIdBytes = data.subarray(20, 26);
  const port = decodedReply.readUint32LE(4);
  const serialNumber = decodedReply.toString("ascii", 8, 40);
  const address = decodedReply.subarray(0, 4).toReversed().join(".");
  const ssidLength = decodedReply[40];
  const ssid = decodedReply.toString("ascii", 41, 41 + ssidLength);
  const mac =
    decodedReply.length >= 69 + ssidLength
      ? decodedReply.toString("hex", 63 + ssidLength, 69 + ssidLength + 6)
      : serialNumber.slice(16, 32);

  let type, subtype;
  if (
    decodedReply.length >= 56 + ssidLength &&
    decodedReply[55 + ssidLength] !== 0
  ) {
    type = decodedReply[55 + ssidLength];
    if (decodedReply.length >= 59 + ssidLength) {
      subtype = decodedReply.readUint16LE(57 + ssidLength);
    }
  } else {
    type = parseInt(ssid.split("_")[1].toLowerCase(), 16);
    subtype = 0;
  }

  let reserved,
    flags,
    extra,
    udp_version,
    protocol_version,
    firmware_version,
    randomkey;
  if (decodedReply.length >= 46 + ssidLength) {
    reserved = decodedReply[43 + ssidLength];
    flags = decodedReply[44 + ssidLength];
    extra = decodedReply[45 + ssidLength];
    if (decodedReply.length >= 50 + ssidLength) {
      udp_version = decodedReply.readUint32LE(46 + ssidLength);
    }
    if (decodedReply.length >= 72 + ssidLength) {
      protocol_version = decodedReply.toString(
        "hex",
        69 + ssidLength,
        72 + ssidLength
      );
      if (decodedReply.length >= 75 + ssidLength) {
        firmware_version = `${decodedReply[72 + ssidLength]}.${
          decodedReply[73 + ssidLength]
        }.${decodedReply[74 + ssidLength]}`;
      }
      if (decodedReply.length >= 94 + ssidLength) {
        randomkey = decodedReply.subarray(78 + ssidLength, 94 + ssidLength);
      }
    }
  }

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
  //   const udpid = convertUDPId(deviceIdBytes);
  const udpid = convertUDPId(deviceIdBytes.toReversed());

  function baseForm() {
    const d: Record<string, string | number> = {
      appId: Constants.AppId,
      clientType: Constants.ClientType,
      format: Constants.RequestFormat,
      language: Constants.Language,
      src: Constants.RequestSource,
      stamp: timestamp(),
    };
    return d;
  }

  let form: Record<string, string | number> = {
    ...baseForm(),
    loginAccount: process.env.MIDEA_ACCOUNT!,
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
    process.env.MIDEA_PASSWORD!,
    Constants.AppKey
  );
  form = {
    ...baseForm(),
    loginAccount: process.env.MIDEA_ACCOUNT!,
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

  const { accessToken, sessionId, userId } = responseBody.result;

  form = { ...baseForm(), udpid, sessionId };
  url = new URL("https://mapp.appsmb.com/v1/iot/secure/getToken");
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
    throw new Error("getToken response not ok");
  }
  if (response.status !== 200) {
    throw new Error("unexpected getToken status");
  }
  responseBody = await response.json();
  if (responseBody.errorCode && parseInt(responseBody.errorCode)) {
    throw new Error(
      `getToken error: ${responseBody.errorCode}, ${responseBody.msg}`
    );
  }
  const { token, key } = responseBody.result.tokenlist.find(
    ({ udpId }) => udpId === udpid
  );

  const device = new LANDevice(address, port);
  await device.authenticate(token, key);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // const refreshResp = await device.request8370(
  //   createLanCommand(
  //     deviceIdBytes,
  //     new DeviceCapabilitiesCommand(type),
  //     signKey
  //   )
  // );

  const cmd: BaseCommand = new AirConditionerStatusCommand();

  let lanPacket = createLanCommand(deviceIdBytes, cmd, signKey);
  let statusResp = await device.request8370(lanPacket);
  let selected = statusResp[0];
  if (selected.length < 10) {
    throw new Error("Invalid extended response");
  }
  if (![2, 3, 4, 5].includes(selected[9])) {
    throw new Error("Unknown extended response");
  }
  const status = parseACStatus(selected.subarray(10));

  const setCmd = new AirConditionerSetCommand();
  setCmd.temperature = 25;

  lanPacket = createLanCommand(deviceIdBytes, setCmd, signKey);
  statusResp = await device.request8370(lanPacket);
  selected = statusResp[0];
  if (selected.length < 10) {
    throw new Error("Invalid extended response");
  }
  if (![2, 3, 4, 5].includes(selected[9])) {
    throw new Error("Unknown extended response");
  }
});

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

enum MessageType {
  HANDSHAKE_REQUEST = 0x0,
  HANDSHAKE_RESPONSE = 0x1,
  ENCRYPTED_RESPONSE = 0x3,
  ENCRYPTED_REQUEST = 0x6,
  TRANSPARENT = 0xf,
}
const ENCRYPTED_MESSAGE_TYPES = [
  MessageType.ENCRYPTED_RESPONSE,
  MessageType.ENCRYPTED_REQUEST,
];

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
    const leftover = null;
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

  private connected: Promise<void>;

  constructor(
    private readonly address: string,
    private readonly port: number
  ) {
    this.client.on("error", (err) => {
      console.error(err);
    });
    this.connected = new Promise((resolve) => {
      this.client.connect(port, address, () => {
        resolve();
      });
    });
  }

  async request8370(data: Uint8Array) {
    const response = await this.request(
      this.security.encode8370(data, MessageType.ENCRYPTED_REQUEST)
    );
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

  async request(message: Uint8Array) {
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

    return await new Promise<Buffer>((resolve) => {
      const receive = (data: Buffer) => {
        this.client.off("data", receive);
        resolve(data);
      };
      this.client.on("data", receive);
    });
  }

  async authenticate(token: string, key: string) {
    const byteToken = Buffer.from(token, "hex");

    const data = this.security.encode8370(
      byteToken,
      MessageType.HANDSHAKE_REQUEST
    );
    const response = (await this.request(data)).subarray(8, 72);

    if (Buffer.from(new TextEncoder().encode("ERROR")).equals(response)) {
      throw new Error("handshake failed");
    }

    // const byteKey = new Uint8Array([
    //   3, 23, 250, 39, 173, 221, 75, 21, 148, 93, 234, 191, 89, 97, 169, 207,
    //   141, 201, 160, 140, 158, 116, 70, 116, 186, 237, 179, 70, 98, 178, 81, 13,
    // ]);
    // const response = new Uint8Array([
    //   18, 252, 101, 55, 138, 133, 95, 211, 165, 67, 213, 107, 83, 219, 215, 112,
    //   115, 55, 15, 58, 189, 82, 152, 210, 104, 142, 246, 159, 242, 78, 237, 135,
    //   100, 250, 129, 87, 112, 144, 147, 92, 122, 182, 231, 251, 56, 233, 140,
    //   27, 56, 103, 64, 227, 28, 208, 220, 175, 194, 35, 218, 220, 91, 179, 181,
    //   225,
    // ]);

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

server.on("error", (err) => {
  console.error(err);
});

server.on("listening", () => {
  const address = server.address();
  console.debug(
    `discovery server listening ${address.address}:${address.port}`
  );
  console.debug(`sending discovery ping`);
  server.send(DISCOVERY_MSG, 6445, "255.255.255.255");
});

server.bind(() => {
  server.setBroadcast(true);
});
