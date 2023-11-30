import { API } from "homebridge";
import { MideaPlatform } from "./MideaPlatform";
import { PLATFORM_NAME } from "./settings";

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, MideaPlatform);
};
