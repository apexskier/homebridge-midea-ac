import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
} from "homebridge";
import { MideaPlatform } from "./MideaPlatform";
import { MideaDeviceType } from "./enums/MideaDeviceType";
import { MideaSwingMode } from "./enums/MideaSwingMode";
import { ACOperationalMode } from "./enums/ACOperationalMode";
import { ensureNever } from "./ensureNever";

export class MideaAccessory {
  // Common
  public powerState: boolean = false;
  public audibleFeedback: boolean = true;
  public operationalMode: ACOperationalMode = ACOperationalMode.Off;
  public fanSpeed: number = 0;

  // Air Conditioner
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
  public screenDisplay: boolean = true;

  private heaterCoolerService!: Service;
  private fanService!: Service;
  private outdoorTemperatureService!: Service;

  constructor(
    private readonly platform: MideaPlatform,
    private readonly accessory: PlatformAccessory
  ) {
    if (this.accessory.context.deviceType !== MideaDeviceType.AirConditioner) {
      this.platform.log.error(
        "Unsupported device type: ",
        MideaDeviceType[this.accessory.context.deviceType]
      );
      return;
    }

    this.platform.log.info(
      `Creating device: ${this.accessory.context.name}, with ID: ${this.accessory.context.deviceId}`
    );

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Midea")
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../package.json").version
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.accessory.context.modelNumber
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.context.sn
      );

    // Air Conditioner
    this.heaterCoolerService =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);
    this.heaterCoolerService.setCharacteristic(
      this.platform.Characteristic.Name,
      this.accessory.context.name
    );
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.getHeaterCoolerActive())
      .onSet((value: CharacteristicValue) => {
        this.platform.log.debug(`Triggered SET Active To: ${value}`);
        const targetPowerState =
          value === this.platform.Characteristic.Active.ACTIVE;
        if (this.powerState !== targetPowerState) {
          this.powerState = targetPowerState;
          this.platform.sendUpdateToDevice(this);
        }
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
      .onGet(() => this.getCurrentHeaterCoolerState());
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.getTargetHeaterCoolerState())
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET HeaterCooler State To: ${value}`
        );
        if (this.getTargetHeaterCoolerState() !== value) {
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
              throw new Error(`unknown target heater cooler state: ${value}`);
          }
          this.platform.sendUpdateToDevice(this);
        }
      });
    this.heaterCoolerService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({
        minValue: -100,
        maxValue: 100,
        minStep: 0.1,
      })
      .onGet(() => this.indoorTemperature);
    this.heaterCoolerService
      .getCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature
      )
      .setProps({
        minValue: this.minTemperature,
        maxValue: this.maxTemperature,
        minStep: this.temperatureSteps,
      })
      .onGet(() => this.targetTemperature)
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET ThresholdTemperature To: ${value}˚C`
        );
        if (this.targetTemperature !== Number(value)) {
          this.targetTemperature = Number(value);
          this.platform.sendUpdateToDevice(this);
        }
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
          `Triggered SET Temperature Display Units To: ${value}`
        );
        const valueIsFahrenheit =
          value ===
          this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
        if (this.useFahrenheit !== valueIsFahrenheit) {
          this.useFahrenheit = valueIsFahrenheit;
          this.platform.sendUpdateToDevice(this);
        }
      });

    // // Use to control Screen display
    // this.heaterCoolerService
    //   .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
    //   .onGet(() =>
    //     this.screenDisplay
    //       ? this.platform.Characteristic.LockPhysicalControls
    //           .CONTROL_LOCK_DISABLED
    //       : this.platform.Characteristic.LockPhysicalControls
    //           .CONTROL_LOCK_ENABLED
    //   )
    //   .onSet((value) => {
    //     this.platform.log.debug(`Triggered SET Screen Display To: ${value}`);
    //     const valueIsUnlocked =
    //       value ===
    //       this.platform.Characteristic.LockPhysicalControls
    //         .CONTROL_LOCK_DISABLED;
    //     if (this.screenDisplay !== valueIsUnlocked) {
    //       this.screenDisplay = valueIsUnlocked;
    //       this.platform.sendUpdateToDevice(this);
    //     }
    //   });

    this.fanService =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, "Fan");
    this.fanService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getFanActive.bind(this))
      .onSet((value) => {
        if (value === this.platform.Characteristic.Active.ACTIVE) {
          this.powerState = true;
          this.operationalMode = ACOperationalMode.FanOnly;
        } else {
          this.operationalMode = ACOperationalMode.Off;
        }
        this.platform.sendUpdateToDevice(this);
      });
    this.fanService
      .getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.getCurrentFanState.bind(this));
    this.fanService
      .getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onGet(this.getTargetFanState.bind(this))
      .onSet((value) => {
        if (value === this.platform.Characteristic.TargetFanState.AUTO) {
          this.fanSpeed = 102;
          this.platform.sendUpdateToDevice(this);
        }
      });
    this.fanService
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.getSwingMode.bind(this))
      .onSet(this.setSwingMode.bind(this));
    this.fanService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.getRotationSpeed.bind(this))
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET RotationSpeed To: ${value}`);
        if (typeof value !== "number") {
          throw new Error("value not number");
        }
        // transform values in percent
        // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
        if (value === 0) {
          this.fanSpeed = 102;
          this.operationalMode = ACOperationalMode.Off;
        } else if (value <= 20) {
          this.fanSpeed = 20;
        } else if (value > 20 && value <= 40) {
          this.fanSpeed = 40;
        } else if (value > 40 && value <= 60) {
          this.fanSpeed = 60;
        } else if (value > 60 && value <= 80) {
          this.fanSpeed = 80;
        } else {
          this.fanSpeed = 100;
        }
        this.platform.sendUpdateToDevice(this);
      });

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
      .onGet(() => this.outdoorTemperature);

    // Update HomeKit
    setInterval(() => {
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.getHeaterCoolerActive()
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.CurrentHeaterCoolerState,
        this.getCurrentHeaterCoolerState()
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.TargetHeaterCoolerState,
        this.getTargetHeaterCoolerState()
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.indoorTemperature
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
        this.targetTemperature
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
        this.getSwingMode()
      );
      this.heaterCoolerService.updateCharacteristic(
        this.platform.Characteristic.TemperatureDisplayUnits,
        this.getTemperatureDisplayUnits()
      );
      //   this.heaterCoolerService.updateCharacteristic(
      //     this.platform.Characteristic.LockPhysicalControls,
      //     this.screenDisplay
      //       ? this.platform.Characteristic.LockPhysicalControls
      //           .CONTROL_LOCK_DISABLED
      //       : this.platform.Characteristic.LockPhysicalControls
      //           .CONTROL_LOCK_ENABLED
      //   );

      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.getFanActive()
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.CurrentFanState,
        this.getCurrentFanState()
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.TargetFanState,
        this.getTargetFanState()
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.getRotationSpeed()
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
        this.getSwingMode()
      );

      this.outdoorTemperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.outdoorTemperature
      );
    }, 5000);
  }

  get name() {
    return this.accessory.context.name;
  }

  get deviceId() {
    return this.accessory.context.deviceId;
  }

  getHeaterCoolerActive() {
    return this.powerState
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  getCurrentHeaterCoolerState() {
    if (!this.powerState) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.operationalMode) {
      case ACOperationalMode.Dry:
      case ACOperationalMode.Cooling:
      case ACOperationalMode.CustomDry:
      case ACOperationalMode.Auto:
        if (this.indoorTemperature >= this.targetTemperature) {
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
        ensureNever(this.operationalMode);
    }
  }

  getTargetHeaterCoolerState() {
    switch (this.operationalMode) {
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
        ensureNever(this.operationalMode);
    }
  }

  getRotationSpeed() {
    // values from device are 20="Silent",40="Low",60="Medium",80="High",100="Full",101/102="Auto"
    // New Midea devices has slider between 1%-100%
    // convert to good usable slider in homekit in percent
    switch (this.fanSpeed) {
      case 0:
      case 20:
      case 40:
      case 60:
      case 80:
      case 100:
        return this.fanSpeed;
      case 101:
      case 102:
        // TODO undefined, auto
        return 50;
      default:
        throw new Error(`unknown midea fan speed ${this.fanSpeed}`);
    }
  }

  getTemperatureDisplayUnits() {
    return this.useFahrenheit
      ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  setSwingMode(value: CharacteristicValue) {
    this.platform.log.debug(`Triggered SET SwingMode To: ${value}`);
    // convert this.swingMode to a 0/1
    if (this.swingMode !== value) {
      this.swingMode = value ? this.supportedSwingMode : 0;
      this.platform.sendUpdateToDevice(this);
    }
  }

  getSwingMode() {
    return this.swingMode !== 0
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  getFanActive() {
    if (!this.powerState) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.powerState && this.operationalMode === ACOperationalMode.FanOnly
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  getCurrentFanState() {
    if (!this.powerState) {
      return this.platform.Characteristic.CurrentFanState.INACTIVE;
    }
    switch (this.operationalMode) {
      case ACOperationalMode.FanOnly:
        return this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
      default:
        return this.platform.Characteristic.CurrentFanState.IDLE;
    }
  }

  getTargetFanState() {
    return this.fanSpeed === 102 || this.fanSpeed === 101
      ? this.platform.Characteristic.TargetFanState.AUTO
      : this.platform.Characteristic.TargetFanState.MANUAL;
  }
}
