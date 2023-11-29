export enum MideaDeviceType {
  Plug = 0x10,
  RemoteController = 0x11,
  AirBox = 0x12,
  Light = 0x13,
  Curtain = 0x14,
  MBox = 0x1b,

  Dehumidifier = 0xa1,
  AirConditioner = 0xac,

  MicroWaveOven = 0xb0,
  BigOven = 0xb1,
  SteamerOven = 0xb2,
  Sterilizer = 0xb3,
  Toaster = 0xb4,
  Hood = 0xb6,
  Hob = 0xb7,
  VacuumCleaner = 0xb8,
  Induction = 0xb9,

  Refrigerator = 0xca,
  MDV = 0xcc,
  AirWaterHeater = 0xcd,

  PulsatorWasher = 0xda,
  DurmWasher = 0xdb,
  ClothesDryer = 0xdc,

  DishWasher = 0xe1,
  ElectricWaterHeater = 0xe2,
  GasWaterHeater = 0xe3,
  RiceCooker = 0xea,
  InductionCooker = 0xeb,
  PressureCooker = 0xec,
  WaterPurifier = 0xed,
  SoybeanMachine = 0xef,

  ElectricFanner = 0xfa,
  ElectricHeater = 0xfb,
  AirPurifier = 0xfc,
  Humidifier = 0xfd,
  AirConditionFanner = 0xfe,

  AllType = 0xff,
}
