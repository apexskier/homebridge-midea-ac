<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Midea A/C

This is a homebridge plugin that supports specifically the Midea U-Shaped 12k BTU Window Air Conditioner (model MAW12AV1QWT) that I got from Costco.

I've customized this fork pretty highly to my specific use cases, feel free to fork to customize for yours. I enable an outdoor temperature sensor, and expose a separate "fan" accessory so I can use it without the AC.

## Gotchas

- midea only allows one login session at a time - you'll get logged out of the app when this starts, and logging into the app will log out homebridge (which will then try to log back in)
