import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
} from "homebridge";
import { MideaPlatform } from "./MideaPlatform";
import { MideaDeviceType } from "./enums/MideaDeviceType";
import { MideaSwingMode } from "./enums/MideaSwingMode";
import { ACOperationalMode } from "./enums/ACOperationalMode";
import { ensureNever } from "./ensureNever";

export class MideaAccessory {
  public deviceId: string = "";
  public deviceType: MideaDeviceType = MideaDeviceType.AirConditioner;

  // AirConditioner
  public targetTemperature: number = 24;
  public indoorTemperature: number = 0;
  public outdoorTemperature: number = 0;
  public useFahrenheit: boolean = false; // Default unit is Celsius. this is just to control the temperature unit of the AC's display. The target temperature setter always expects a celsius temperature (resolution of 0.5C), as does the midea API
  public turboFan: boolean = false;
  public fanOnlyMode: boolean = false;
  public swingMode: number = 0;
  public supportedSwingMode: MideaSwingMode = MideaSwingMode.Vertical;
  public temperatureSteps: number = 1;
  public minTemperature: number = 17;
  public maxTemperature: number = 30;
  public ecoMode: boolean = false;
  public turboMode: boolean = false;
  public comfortSleep: boolean = false;
  public dryer: boolean = false;
  public purifier: boolean = false;
  public screenDisplay: number = 1;

  // Common
  public powerState: number = 0;
  public audibleFeedback: boolean = true;
  public operationalMode: ACOperationalMode = ACOperationalMode.Off;
  public fanSpeed: number = 0;

  public name: string = "";
  public model: string = "";
  public userId: string = "";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  public firmwareVersion = require("../package.json").version;

  private service!: Service;
  private outdoorTemperatureService!: Service;

  constructor(
    private readonly platform: MideaPlatform,
    private readonly accessory: PlatformAccessory,
    private _deviceId: string,
    private _deviceType: MideaDeviceType,
    private _name: string,
    private _userId: string
  ) {
    this.deviceId = _deviceId;
    this.deviceType = _deviceType;
    this.name = _name;
    this.userId = _userId;

    this.platform.log.info(
      `Created device: ${this.name}, with ID: ${this.deviceId}, and type: ${this.deviceType}`
    );

    if (this.deviceType === MideaDeviceType.AirConditioner) {
      this.model = "Air Conditioner";
    } else this.model = "Undefined";

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Midea")
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.firmwareVersion
      )
      .setCharacteristic(this.platform.Characteristic.Model, this.model)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.deviceId
      );

    if (this.deviceType !== MideaDeviceType.AirConditioner) {
      this.platform.log.error(
        "Unsupported device type: ",
        MideaDeviceType[this.deviceType]
      );
      return;
    }

    // Air Conditioner
    this.service =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.name
    );
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .on("get", this.handleActiveGet.bind(this))
      .on("set", this.handleActiveSet.bind(this));
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .on("get", this.handleCurrentHeaterCoolerStateGet.bind(this));
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .on("get", this.handleTargetHeaterCoolerStateGet.bind(this))
      .on("set", this.handleTargetHeaterCoolerStateSet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .on("get", this.handleCurrentTemperatureGet.bind(this))
      .setProps({
        minValue: -100,
        maxValue: 100,
        minStep: 0.1,
      });
    this.service
      .getCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature
      )
      .on("get", this.handleThresholdTemperatureGet.bind(this))
      .on("set", this.handleThresholdTemperatureSet.bind(this))
      .setProps({
        minValue: this.minTemperature,
        maxValue: this.maxTemperature,
        minStep: this.temperatureSteps,
      });
    this.service
      .getCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature
      )
      .on("get", this.handleThresholdTemperatureGet.bind(this))
      .on("set", this.handleThresholdTemperatureSet.bind(this))
      .setProps({
        minValue: this.minTemperature,
        maxValue: this.maxTemperature,
        minStep: this.temperatureSteps,
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on("get", this.handleRotationSpeedGet.bind(this))
      .on("set", this.handleRotationSpeedSet.bind(this));
    this.service
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .on("get", this.handleSwingModeGet.bind(this))
      .on("set", this.handleSwingModeSet.bind(this));
    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .on("get", this.handleTemperatureDisplayUnitsGet.bind(this))
      .on("set", this.handleTemperatureDisplayUnitsSet.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
        ],
      });
    // Use to control Screen display
    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .on("get", this.handleLockPhysicalControlsGet.bind(this))
      .on("set", this.handleLockPhysicalControlsSet.bind(this));

    // Update HomeKit
    setInterval(() => {
      this.service.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.powerState
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeaterCoolerState,
        this.currentHeaterCoolerState()
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeaterCoolerState,
        this.targetHeaterCoolerState()
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.indoorTemperature
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
        this.targetTemperature
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature,
        this.targetTemperature
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.rotationSpeed()
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
        this.getSwingMode()
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.TemperatureDisplayUnits,
        this.useFahrenheit
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.LockPhysicalControls,
        this.screenDisplay
      );
    }, 5000);

    this.platform.log.debug("Add Outdoor Temperature Sensor");
    this.outdoorTemperatureService =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor);
    this.outdoorTemperatureService.setCharacteristic(
      this.platform.Characteristic.Name,
      "Outdoor Temperature"
    );
    this.outdoorTemperatureService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .on("get", this.handleOutdoorTemperatureGet.bind(this));
  }

  handleActiveGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET Active");
    if (this.powerState === 1) {
      callback(null, this.platform.Characteristic.Active.ACTIVE);
    } else {
      callback(null, this.platform.Characteristic.Active.INACTIVE);
    }
  }

  handleActiveSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    if (this.powerState !== Number(value)) {
      this.platform.log.debug(`Triggered SET Active To: ${value}`);
      this.powerState = Number(value);
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  public currentHeaterCoolerState() {
    if (this.powerState === this.platform.Characteristic.Active.INACTIVE) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.operationalMode) {
      case ACOperationalMode.Dry:
      case ACOperationalMode.Cooling:
      case ACOperationalMode.CustomDry:
        if (this.indoorTemperature >= this.targetTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        }
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case ACOperationalMode.Heating:
        if (this.indoorTemperature <= this.targetTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        }
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case ACOperationalMode.Auto:
        if (this.indoorTemperature > this.targetTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        }
        if (this.indoorTemperature < this.targetTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        }
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      case ACOperationalMode.Off:
        return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
      case ACOperationalMode.FanOnly:
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      default:
        ensureNever(this.operationalMode);
    }
  }

  handleCurrentHeaterCoolerStateGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET Current HeaterCooler State");
    callback(null, this.currentHeaterCoolerState());
  }

  targetHeaterCoolerState() {
    if (this.operationalMode === ACOperationalMode.Cooling) {
      return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    }
    if (this.operationalMode === ACOperationalMode.Heating) {
      return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
    }
    return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  handleTargetHeaterCoolerStateGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET Target HeaterCooler State");
    callback(null, this.targetHeaterCoolerState());
  }

  handleTargetHeaterCoolerStateSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    if (this.targetHeaterCoolerState() !== value) {
      this.platform.log.debug(`Triggered SET HeaterCooler State To: ${value}`);
      switch (value) {
        case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
          this.operationalMode = ACOperationalMode.Auto;
          break;
        case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
          this.operationalMode = ACOperationalMode.Cooling;
          break;
        case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
          this.operationalMode = ACOperationalMode.Heating;
          break;
        default:
          throw new Error("unknown target heater cooler state");
      }
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  handleCurrentTemperatureGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET CurrentTemperature");
    callback(null, this.indoorTemperature);
  }

  handleThresholdTemperatureGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET ThresholdTemperature");
    callback(null, this.targetTemperature);
  }

  handleThresholdTemperatureSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    if (this.useFahrenheit === true) {
      this.platform.log.debug(
        `Triggered SET ThresholdTemperature To: ${value}˚F`
      );
    } else {
      this.platform.log.debug(
        `Triggered SET ThresholdTemperature To: ${value}˚C`
      );
    }
    if (this.targetTemperature !== Number(value)) {
      this.targetTemperature = Number(value);
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  public rotationSpeed() {
    // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
    // New Midea devices has slider between 1%-100%
    // convert to good usable slider in homekit in percent
    let currentValue = 0;
    switch (this.fanSpeed) {
      case 20:
        currentValue = 20;
        break;
      case 40:
        currentValue = 40;
        break;
      case 60:
        currentValue = 60;
        break;
      case 80:
        currentValue = 80;
        break;
      case 101:
      case 102:
        currentValue = 100;
        break;
    }
    return currentValue;
  }

  handleRotationSpeedGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET RotationSpeed");
    callback(null, this.rotationSpeed());
  }

  handleRotationSpeedSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    this.platform.log.debug(`Triggered SET RotationSpeed To: ${value}`);
    if (typeof value !== "number") {
      throw new Error("value not number");
    }
    // transform values in percent
    // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
    if (this.fanSpeed !== value) {
      if (value <= 20) {
        this.fanSpeed = 20;
      } else if (value > 20 && value <= 40) {
        this.fanSpeed = 40;
      } else if (value > 40 && value <= 60) {
        this.fanSpeed = 60;
      } else if (value > 60 && value <= 80) {
        this.fanSpeed = 80;
      } else {
        this.fanSpeed = 102;
      }
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  getSwingMode() {
    return this.swingMode !== 0
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  handleSwingModeGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET SwingMode");
    callback(null, this.getSwingMode());
  }

  handleSwingModeSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    this.platform.log.debug(`Triggered SET SwingMode To: ${value}`);
    // convert this.swingMode to a 0/1
    if (this.swingMode !== value) {
      this.swingMode = value ? this.supportedSwingMode : 0;
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  handleTemperatureDisplayUnitsGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET Temperature Display Units");
    if (this.useFahrenheit === true) {
      callback(
        null,
        this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      );
    } else {
      callback(
        null,
        this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      );
    }
  }

  handleTemperatureDisplayUnitsSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    this.platform.log.debug(
      `Triggered SET Temperature Display Units To: ${value}`
    );
    if (this.useFahrenheit !== value) {
      if (value === 1) {
        this.useFahrenheit = true;
      } else {
        this.useFahrenheit = false;
      }
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  handleLockPhysicalControlsGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET Screen Display");
    if (this.screenDisplay === 1) {
      callback(
        null,
        this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      );
    } else {
      callback(
        null,
        this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED
      );
    }
  }

  handleLockPhysicalControlsSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    if (this.screenDisplay !== Number(value)) {
      this.platform.log.debug(`Triggered SET Screen Display To: ${value}`);
      this.screenDisplay = Number(value);
      this.platform.sendUpdateToDevice(this);
    }
    callback(null);
  }

  // Fan mode
  // Get the current value of the "FanActive" characteristic
  public fanActive() {
    if (
      this.operationalMode === ACOperationalMode.FanOnly &&
      this.powerState === this.platform.Characteristic.Active.ACTIVE
    ) {
      return this.platform.Characteristic.Active.ACTIVE;
    } else {
      return this.platform.Characteristic.Active.INACTIVE;
    }
  }

  handleFanActiveGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET FanMode");
    callback(null, this.fanActive());
  }

  handleFanActiveSet(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ) {
    this.platform.log.debug(`Triggered SET FanMode To: ${value}`);
    if (value === 1 && this.powerState === 1) {
      this.operationalMode = ACOperationalMode.FanOnly;
    } else if (value === 1 && this.powerState === 0) {
      this.powerState = this.platform.Characteristic.Active.ACTIVE;
      this.operationalMode = ACOperationalMode.FanOnly;
    } else if (value === 0 && this.powerState === 1) {
      this.powerState = this.platform.Characteristic.Active.INACTIVE;
    }
    this.platform.sendUpdateToDevice(this);
    callback(null);
  }

  handleOutdoorTemperatureGet(callback: CharacteristicGetCallback) {
    this.platform.log.debug("Triggered GET CurrentTemperature");
    callback(null, this.outdoorTemperature);
  }
}
