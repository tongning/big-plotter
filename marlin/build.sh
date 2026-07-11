#!/bin/sh
# Build the plotter's Marlin firmware for the SKR 1.4 (LPC1768).
# Requires PlatformIO (pipx install platformio). Output: marlin/firmware.bin
set -e
cd "$(dirname "$0")"

if [ ! -d Marlin ]; then
  git clone --depth 1 --branch 2.1.2.5 \
    https://github.com/MarlinFirmware/Marlin.git Marlin
fi

cp config/Configuration.h config/Configuration_adv.h Marlin/Marlin/
cp config/pins_BTT_SKR_V1_4.h Marlin/Marlin/src/pins/lpc1768/

(cd Marlin && pio run -e LPC1768)

cp Marlin/.pio/build/LPC1768/firmware.bin firmware.bin
echo "wrote $(pwd)/firmware.bin"
