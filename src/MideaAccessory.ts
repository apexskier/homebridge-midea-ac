import type { Service, PlatformAccessory } from "homebridge";
import { MideaPlatform } from "./MideaPlatform";
import { MideaDeviceType } from "./enums/MideaDeviceType";
import { MideaSwingMode } from "./enums/MideaSwingMode";
import { ACOperationalMode } from "./enums/ACOperationalMode";
import { ensureNever } from "./ensureNever";

export class MideaAccessory {
  // Common
  public powerState: number = 0;
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
  //   public screenDisplay: number = 1;

  private service!: Service;
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
    this.service =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.accessory.context.name
    );
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() =>
        this.powerState === 1
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE
      )
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET Active To: ${value}`);
        if (this.powerState !== Number(value)) {
          this.powerState = Number(value);
          this.platform.sendUpdateToDevice(this);
        }
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.CurrentHeaterCoolerState.IDLE,
          this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE,
          this.platform.Characteristic.CurrentHeaterCoolerState.COOLING,
        ],
      })
      .onGet(() => {
        this.platform.log.debug("Triggered GET Current HeaterCooler State");
        return this.currentHeaterCoolerState();
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.targetHeaterCoolerState())
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET HeaterCooler State To: ${value}`
        );
        if (this.targetHeaterCoolerState() !== value) {
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
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({
        minValue: -100,
        maxValue: 100,
        minStep: 0.1,
      })
      .onGet(() => this.indoorTemperature);
    this.service
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
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(() => this.rotationSpeed())
      .onSet((value) => {
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
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(() => this.getSwingMode())
      .onSet((value) => {
        this.platform.log.debug(`Triggered SET SwingMode To: ${value}`);
        // convert this.swingMode to a 0/1
        if (this.swingMode !== value) {
          this.swingMode = value ? this.supportedSwingMode : 0;
          this.platform.sendUpdateToDevice(this);
        }
      });
    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .setProps({
        validValues: [
          this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
          this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
        ],
      })
      .onGet(() =>
        this.useFahrenheit
          ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      )
      .onSet((value) => {
        this.platform.log.debug(
          `Triggered SET Temperature Display Units To: ${value}`
        );
        if (this.useFahrenheit !== value) {
          this.useFahrenheit = value === 1;
          this.platform.sendUpdateToDevice(this);
        }
      });

    // // Use to control Screen display
    // this.service
    //   .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
    //   .onGet(() =>
    //     this.screenDisplay === 1
    //       ? this.platform.Characteristic.LockPhysicalControls
    //           .CONTROL_LOCK_ENABLED
    //       : this.platform.Characteristic.LockPhysicalControls
    //           .CONTROL_LOCK_DISABLED
    //   )
    //   .onSet((value) => {
    //     if (this.screenDisplay !== Number(value)) {
    //       this.platform.log.debug(`Triggered SET Screen Display To: ${value}`);
    //       this.screenDisplay = Number(value);
    //       this.platform.sendUpdateToDevice(this);
    //     }
    //   });

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
      //   this.service.updateCharacteristic(
      //     this.platform.Characteristic.LockPhysicalControls,
      //     this.screenDisplay
      //   );
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
      .onGet(() => this.outdoorTemperature);
  }

  get name() {
    return this.accessory.context.name;
  }

  get deviceId() {
    return this.accessory.context.deviceId;
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
        this.platform.log.warn("unexpectedly in heating state");
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

  targetHeaterCoolerState() {
    if (this.operationalMode === ACOperationalMode.Cooling) {
      return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    }
    if (this.operationalMode === ACOperationalMode.Heating) {
      return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
    }
    return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  rotationSpeed() {
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

  getSwingMode() {
    return this.swingMode !== 0
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }
}
