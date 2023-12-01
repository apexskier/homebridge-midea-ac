<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Midea A/C

This is a homebridge plugin that supports specifically the Midea U-Shaped 12k BTU Window Air Conditioner (model MAW12AV1QWT) that I got from Costco.

I've customized this fork pretty highly to my specific use cases, feel free to fork to customize for yours.

- Uses LAN connection for status and control, instead of the Midea HTTP API. This is quite a bit more reliable. Midea's HTTP API is still required for authentication.
- Enable an outdoor temperature sensor.
- Expose a separate fan accessory so I can control fan-only mode without the AC.

## Gotchas

- HomeKit's "Auto" mode for Heater/Coolers disables the temperature dial in the iOS app (not macOS), so I don't support it. It's semantically different than Midea's "Auto" though.
- LAN status doesn't contain "beep" or "screen on" status. I decided against fetching from the HTTP API. The LAN set command has a beep/screen setting, but I think it's "does this command activate this", not a persistent setting.
- Comfort sleep in set command doesn't seem to work
