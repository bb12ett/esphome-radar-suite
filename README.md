# 📡 ESPHome mmWave Radar Suite for Home Assistant

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=bb12ett&repository=esphome-radar-suite&category=plugin)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/default)
[![ESPHome](https://img.shields.io/badge/ESPHome-2024.6+-orange.svg)](https://esphome.io)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.1+-blue.svg)](https://www.home-assistant.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An all-in-one, high-precision mmWave radar visualization and calibration suite for **Home Assistant** and **ESPHome HLK-LD2450**.

This suite provides real-time multi-target tracking, true architectural room boundaries with mounting rotation, a walk-in calibration wizard, and flexible multi-mode software zones (detection and exclusion) in a clean, zero-dependency package.

<p align="center">
  <img src="images/preview.png" alt="ESPHome mmWave Radar Suite Preview" width="100%" />
</p>

---

> [!WARNING]
> ### ⚠️ Breaking Change in v1.8.0: YAML Firmware Update Required
> **v1.8.0 transitions software zones to native Home Assistant entity registry management (`disabled_by_default: true`).**
> 
> * **Zero Device Page Clutter**: All 10 zones are now disabled by default in firmware. Inactive zones are tucked away into Home Assistant's collapsed disabled entities section rather than cluttering your device page with `(Hidden) Unknown` items.
> * **Independent Zone Support (`➕ Add Zone` / `🗑️ Disable Zone`)**: The sequential `Active Zones` number counter has been completely removed. You can now enable and disable any individual zone slot (e.g. Zone 1 and Zone 3) using the **`➕ Add Zone`** and **`🗑️ Disable`** buttons directly in the calibration card.
> * **Required Action**: 
>   1. Update your sensor configuration to the latest [`ld2450_full.yaml`](esphome/ld2450_full.yaml) and reflash your ESP32.
>   2. After reflashing, the obsolete `number.<device>_active_zones` entity will appear as orphaned/unavailable in Home Assistant and can be safely deleted.

---

## 🌟 Key Features

### 1. 🎯 Real-Time Radar Map Card (`custom:radar-map-card`)
- **Live 2D Room Visualization**: Smoothly tracks up to 3 simultaneous targets with real-time distance, speed, and movement trails.
- **True Room Dimensions**: Enter your room's width and depth to see realistic physical boundaries.
- **Flexible Sensor Placement**: Mount your sensor centered, offset along a wall, or rotated in a corner (e.g. $45^\circ$) — targets and zones automatically align with your room.
- **Dual Display Modes**: Choose between `full` (radar map, live target telemetry, and zone status badges) or `minimal` (clean map only for overview dashboards).
- **Auto-Discovery**: Automatically finds and connects to any LD2450 sensor in your Home Assistant setup.

### 2. 🛠️ Presence Calibration Suite (`custom:radar-calibration-card`)
- **Live Viewfinder**: Real-time room map stays pinned at the top across all tabs for instant visual feedback.
- **Walk-in Calibration**: Walk to Corner 1 $\rightarrow$ Click **Capture Corner 1** $\rightarrow$ Walk to Corner 2 $\rightarrow$ Click **Capture Corner 2 & Save**. The card automatically calculates and saves the zone to your sensor.
- **Multi-Mode Zones (Up to 10 Zones)**: Configure up to 10 independent zones. With a single click, set any zone to:
  - 🟢 **Detection Zone**: Tracks room occupants, counts, and maintains stationary presence.
  - 🔴 **Exclusion Mask**: Automatically ignores moving objects like ceiling fans, curtains, or robot vacuums so they don't trigger false occupancy.
- **Dynamic Zones & Clean Device Page**: All 10 zones are disabled by default. Click **➕ Add Zone** to dynamically enable and configure slots, or click **🗑️ Disable** to reset coordinates and collapse them in Home Assistant.
- **Responsive Layout**: Automatically stacks header controls and device selector on narrow/mobile viewports to prevent squashed dropdowns.
- **Manual Coordinate Tuning**: Direct inputs for `X1`, `Y1`, `X2`, `Y2`, and `Angle (°)`, with quick nudge buttons ($\pm50\text{mm}$, $\pm5^\circ$) and live preview before saving.
- **Mobile-Friendly**: Updates smoothly in the background without dropping focus or closing your mobile keyboard.

---

## 🚀 Installation

### Option 1: One-Click Install via My Home Assistant (Recommended)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=bb12ett&repository=esphome-radar-suite&category=plugin)

### Option 2: Add Custom Repository in HACS
1. Open **HACS** in your Home Assistant UI.
2. Click the three dots in the top right corner $\rightarrow$ **Custom repositories**.
3. Paste the URL of this repository:
   - **Repository**: `https://github.com/bb12ett/esphome-radar-suite`
   - **Type**: `Dashboard` / `Lovelace`
4. Click **Add**, find **ESPHome mmWave Radar Suite**, and click **Download**.
5. Reload your browser.

### Option 3: Manual Installation
1. Download `presence-radar-card.js` from the [`dist/`](dist/presence-radar-card.js) directory.
2. Copy `presence-radar-card.js` to your Home Assistant `config/www/plugins/` directory.
3. In Home Assistant, navigate to **Settings** $\rightarrow$ **Dashboards** $\rightarrow$ **Resources**.
4. Add `/local/plugins/presence-radar-card.js` as a `JavaScript Module`.
5. Refresh your browser (**Ctrl+Shift+R**).

---

## 📋 Lovelace Card Configurations

### 1. Minimal Radar Map (Map Only)
```yaml
type: custom:radar-map-card
title: Living Room Radar
device: living_room_presence       # Locks to sensor & hides dropdown. Omit to enable dropdown.
layout_mode: minimal               # "minimal" or "full"
```

### 2. Full Radar Map (With Telemetry & Zone Badges)
```yaml
type: custom:radar-map-card
title: Living Room Radar
device: living_room_presence
layout_mode: full
```

### 3. Whole-House Dynamic Radar Map
```yaml
type: custom:radar-map-card
title: Home Radar Overview
device: ""                         # Setting to "" enables device dropdown selector
layout_mode: full
```

### 4. Calibration & Onboarding Suite
```yaml
type: custom:radar-calibration-card
title: Presence Onboarding Suite
device: ""                         # Calibrate any sensor in your home from this card!
```

---

## ⚡ ESPHome Configuration

The repository provides two ready-to-use ESPHome setups located in the [`esphome/`](esphome/) folder:

### 1. Full Package (`ld2450_full.yaml`) — Recommended
The complete, production-grade package featuring:
- **Stationary Presence Memory**: Prevents lights turning off when sitting completely still (e.g. reading, watching TV).
- **Up to 10 Multi-Mode Zones**: Set each zone as a Detection Zone or Exclusion Mask.
- **Walk-In Auto-Calibration**: Works seamlessly with the calibration card buttons.
- **Tunable Engine Settings**: Adjustable presence timeouts, off-delays, and exit margins.

#### How to include the Full Package:
1. Place [`presence_memory.h`](esphome/presence_memory.h) and [`ld2450_full.yaml`](esphome/ld2450_full.yaml) into your ESPHome directory (e.g. `config/esphome/`).
2. Create your device YAML:
```yaml
substitutions:
  node_name: "living-room-presence"
  friendly_name: "Living Room Presence"
  tx_pin: "GPIO21"      # LD2450 RX
  rx_pin: "GPIO20"      # LD2450 TX
  board: "esp32-c3-devkitm-1"

packages:
  radar_base: !include ld2450_full.yaml
```

### 2. Minimal Configuration (`ld2450_minimal.yaml`)
For users who want basic tracking using the standard ESPHome component without custom C++ features.
- [View `esphome/ld2450_minimal.yaml`](esphome/ld2450_minimal.yaml)

---

## 📐 Corner & Wall Placement

When mounting your sensor off-center or in a corner at an angle, target coordinates need to translate into your room's layout. 

The suite handles this automatically:
- **Center Mount**: Sensor placed in the middle of a wall pointing into the room.
- **Offset Mount**: Sensor placed anywhere along the wall; targets shift relative to the offset.
- **Corner Mount (e.g. 45°)**: Mount in the corner looking diagonally across the room; both targets and detection zones rotate to stay inside your room boundaries.

---

## 🤖 Built with AI & Human Pair Programming

> [!NOTE]
> This suite was developed through collaborative pair programming with **Antigravity**.

---

## 🤝 Contributing
Contributions, bug reports, and feature requests are welcome! Feel free to submit a Pull Request or open an Issue.

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
