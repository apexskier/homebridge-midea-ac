import BaseCommand from './BaseCommand';
import { MideaDeviceType } from './enums/MideaDeviceType'
import { MideaSwingMode } from './enums/MideaSwingMode'

export default class SetCommand extends BaseCommand {

    constructor(device_type: MideaDeviceType) {
        super(device_type);
    }
    // Byte 0x0b
    get audibleFeedback() {
        if (this.data[0x0b] & 0x42) {
            return true;
        };
        return false;
    };

    set audibleFeedback(feedbackEnabled: boolean) {
        this.data[0x0b] &= ~0x42; // Clear the audible bits
        this.data[0x0b] |= feedbackEnabled ? 0x42 : 0;
    };

    get powerState() {
        return this.data[0x0b] & 0x01;
    };

    set powerState(state) {
        this.data[0x0b] &= ~0x01; // Clear the power bit
        this.data[0x0b] |= state ? 0x01 : 0;
    };
    // Byte 0x0c
    get operationalMode() {
        return (this.data[0x0c] & 0xe0) >> 5;
    };

    set operationalMode(mode: number) {
        this.data[0x0c] &= ~0xe0; // Clear the mode bit
        this.data[0x0c] |= (mode << 5) & 0xe0;
    };

    get temperatureDot5() {
        return (this.data[0x0c] & 0x10) > 0;
    };

    set temperatureDot5(temperatureDot5Enabled: boolean) {
        // add 0.5C to the temperature value. not intended to be called directly. target_temperature setter calls this if needed
        // this.data[0x0c] = temperatureDot5Enabled ? 0x10 : 0;
        if (temperatureDot5Enabled) {
            this.data[0x0c] |= 0x10
        } else {
            this.data[0x0c] &= (~0x10)
        }
    };
    // Byte 0x0d
    get fanSpeed() {
        return this.data[0x0d];
    };

    set fanSpeed(speed: number) {
        this.data[0x0d] = speed;
    };
    // Byte 0x11
    get swingMode() {
        return this.data[0x11];
    };

    set swingMode(mode: MideaSwingMode) {
        this.data[0x11] = 0x30; // Clear the mode bit
        this.data[0x11] |= mode & 0x3f;
        // this.data[0x11] &= ~0x0f; // Clear the mode bit
        // this.data[0x11] |= mode & 0x0f;
    };
    // Byte 0x13
    get ecoMode() {
        return this.data[0x13] > 0;
    };

    set ecoMode(ecoModeEnabled: boolean) {
        this.data[0x13] = ecoModeEnabled ? 0xff : 0;
    };
    // Byte 0x14
    get screenDisplay() {
        return (this.data[0x14] & 0x10) > 0;
    };

    set screenDisplay(screenDisplayEnabled: boolean) {
        // the LED lights on the AC. these display temperature and are often too bright during nights
        // this.data[0x14] = screenDisplayEnabled ? 0x10 : 0;
        if (screenDisplayEnabled) {
            this.data[0x14] |= 0x10
        } else {
            this.data[0x14] &= (~0x10)
        }
    };

    get turboMode() {
        return this.data[0x14] > 0;
    };

    set turboMode(turboModeEnabled: boolean) {
        if (turboModeEnabled) {
            this.data[0x14] |= 0x02
        } else {
            this.data[0x14] &= (~0x02)
        }
        // this.data[0x14] = turboModeEnabled ? 0x02 : 0;
    };
};