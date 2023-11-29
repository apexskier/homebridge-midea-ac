import { API } from "homebridge";
import { MideaPlatform } from "./MideaPlatform";

export = (api: API) => {
  api.registerPlatform("homebridge-midea-air", "midea-air", MideaPlatform);
};
