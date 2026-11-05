/**
 * ESPHome LD2450 mmWave Radar Custom Cards for Home Assistant
 * Version 1.8.1 - Dynamic Per-Zone Enable/Disable Architecture & Responsive UI
 * 
 * Includes:
 * 1. <radar-map-card>         (Lovelace: custom:radar-map-card / custom:presence-radar-card)
 * 2. <radar-calibration-card> (Lovelace: custom:radar-calibration-card / custom:presence-calibration-card)
 */

const CARD_VERSION = "1.8.2";
window.customCards = window.customCards || [];

const cardRegistrations = [
  {
    type: "radar-map-card",
    name: "Radar Map Card (LD2450)",
    description: "Visual mmWave radar presence map with room boundaries, custom sensor placement, multi-target tracking, and detection zones.",
    preview: true
  },
  {
    type: "radar-calibration-card",
    name: "Presence Onboarding & Calibration Card (LD2450)",
    description: "All-in-one onboarding console to configure placement, room boundaries, detection zones, and timeouts for any presence sensor.",
    preview: true
  },
  {
    type: "presence-calibration-card",
    name: "Presence Calibration Card (Alias)",
    description: "All-in-one onboarding console for ESPHome presence sensors.",
    preview: true
  }
];

cardRegistrations.forEach(reg => {
  if (!window.customCards.some(c => c.type === reg.type)) {
    window.customCards.push(reg);
  }
});

console.info(
  `%c PRESENCE-RADAR-CARDS %c v${CARD_VERSION} %c Ready `,
  "background: #0284c7; color: #fff; font-weight: bold; border-radius: 3px 0 0 3px; padding: 2px 5px;",
  "background: #0f172a; color: #38bdf8; font-weight: bold; padding: 2px 5px;",
  "background: #10b981; color: #fff; font-weight: bold; border-radius: 0 3px 3px 0; padding: 2px 5px;"
);

// ====================================================================
// UTILITY: Robust Dynamic Entity Discovery & Fuzzy Resolution
// ====================================================================
// Shared last-known-good state cache: keeps zone / room / version values stable while
// ESPHome entities are briefly "unavailable" (e.g. during an integration reload).
const RADAR_LKG = {};

function radarStableHass(hass) {
  if (!hass || !hass.states) return hass;
  const raw = hass.states;
  const read = (prop) => {
    const s = raw[prop];
    if (typeof prop !== "string" || prop.indexOf(".") === -1) return s;
    if (s && s.state !== "unavailable" && s.state !== "unknown") {
      RADAR_LKG[prop] = s;
      return s;
    }
    return RADAR_LKG[prop] || s;
  };
  // Proxy over an empty target (avoids invariant issues if hass.states is ever frozen)
  const states = new Proxy({}, {
    get: (_t, prop) => read(prop),
    has: (_t, prop) => (prop in raw) || (prop in RADAR_LKG),
    ownKeys: () => Reflect.ownKeys(raw),
    getOwnPropertyDescriptor: (_t, prop) => (prop in raw)
      ? { value: read(prop), enumerable: true, configurable: true, writable: false }
      : undefined
  });
  const h = Object.create(hass);
  Object.defineProperty(h, "states", { value: states, enumerable: true });
  return h;
}

function radarForgetStates(ids) {
  for (const id of ids || []) delete RADAR_LKG[id];
}

// Only touch the DOM when the generated markup actually changed (prevents hover replay / lost clicks)
function radarSetHtml(el, html) {
  if (!el) return false;
  if (el.__radarHtml === html) return false;
  el.innerHTML = html;
  el.__radarHtml = html;
  return true;
}

function radarSlug(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

class RadarEntityResolver {
  static _registryCache = null;
  static _registryMap = null;
  static _registryVersion = 0;
  static _fetchingRegistry = false;
  static _registryFailedAt = 0;
  static _registryListeners = new Set();

  static onRegistryChange(cb) {
    this._registryListeners.add(cb);
    return () => this._registryListeners.delete(cb);
  }

  static _notifyRegistry() {
    this._registryVersion++;
    for (const cb of Array.from(this._registryListeners)) {
      try { cb(); } catch (e) { console.warn("[PRESENCE-RADAR-CARDS] registry listener failed", e); }
    }
  }

  static async loadEntityRegistry(hass, force = false) {
    if (!hass || !hass.callWS) return;
    if (this._registryCache && !force) return;
    if (this._fetchingRegistry) return;
    // Back off for 60s after a failure instead of retrying on every hass update
    if (!force && this._registryFailedAt && (Date.now() - this._registryFailedAt) < 60000) return;
    this._fetchingRegistry = true;
    try {
      const list = await hass.callWS({ type: "config/entity_registry/list" });
      if (Array.isArray(list)) {
        this._registryCache = list.map(e => e.entity_id);
        this._registryMap = new Map(list.map(e => [e.entity_id, e]));
        this._registryFailedAt = 0;
        this._notifyRegistry();
      }
    } catch (e) {
      this._registryFailedAt = Date.now();
      console.warn("[PRESENCE-RADAR-CARDS] Could not load entity registry:", e);
    } finally {
      this._fetchingRegistry = false;
    }
  }

  static refreshEntityRegistry(hass) {
    return this.loadEntityRegistry(hass, true);
  }

  static getDevices(hass) {
    if (!hass || !hass.states) return [];
    const devices = new Map();

    for (const entityId of Object.keys(hass.states)) {
      // True mmWave radar sensors strictly have Target 1 X coordinates
      let match = entityId.match(/^sensor\.(.+?)_target_1_x$/);
      if (!match) match = entityId.match(/^sensor\.(.+?)_t1_x$/);

      if (match) {
        let rawPrefix = match[1];
        // Exclude sub-zones or sub-entities
        if (rawPrefix.includes("_zone_") || rawPrefix.startsWith("zone_")) continue;

        // Clean prefix if it has duplicate area tokens (e.g. living_room_living_room_presence -> living_room_presence)
        const simplifiedPrefix = rawPrefix.replace(/^([a-z0-9_]+)_\1_/, "$1_");
        
        const stateObj = hass.states[entityId];
        let friendlyName = "";
        if (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) {
          friendlyName = stateObj.attributes.friendly_name
            .replace(/Target 1 X/i, "")
            .replace(/T1 X/i, "")
            .trim();
        }
        if (!friendlyName) {
          friendlyName = simplifiedPrefix.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
        }

        if (!devices.has(simplifiedPrefix)) {
          devices.set(simplifiedPrefix, {
            prefix: simplifiedPrefix,
            rawPrefix: rawPrefix,
            name: friendlyName || simplifiedPrefix
          });
        }
      }
    }

    return Array.from(devices.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  static resolve(hass, config = {}) {
    const cfg = config || {};
    const states = (hass && hass.states) || {};
    const devs = RadarEntityResolver.getDevices(hass);
    let prefix = cfg.device || cfg.prefix || "";

    if (!prefix) {
      if (devs.length > 0) {
        prefix = devs[0].prefix;
      } else {
        prefix = "living_room_presence";
      }
    }

    const matchedDev = devs.find(d => d.prefix === prefix || d.rawPrefix === prefix);
    const canonicalPrefix = matchedDev ? matchedDev.prefix : prefix;
    const rawPrefix = matchedDev ? matchedDev.rawPrefix : prefix;

    const registryList = RadarEntityResolver._registryCache || [];
    const entityRegistryKeys = (hass && hass.entities) ? Object.keys(hass.entities) : [];
    const allEntityIds = Array.from(new Set([...Object.keys(states), ...entityRegistryKeys, ...registryList]));
    const tokens = canonicalPrefix.toLowerCase().split(/[_-\s]+/).filter(Boolean);
    const otherDevicePrefixes = new Set();
    for (const d of devs) {
      if (d.prefix !== canonicalPrefix && d.rawPrefix !== rawPrefix) {
        otherDevicePrefixes.add(d.prefix);
        otherDevicePrefixes.add(d.rawPrefix);
      }
    }

    // Infer zonePrefix from existing zone config entities (e.g. handles double-area prefixes like living_room_living_room_presence)
    const stateIds = Object.keys(states);
    const pickSample = (domain, suffix) => stateIds.find(id => {
      if (!id.startsWith(domain + ".") || !id.endsWith(suffix)) return false;
      const entPrefix = id.slice(domain.length + 1, id.length - suffix.length);
      if (otherDevicePrefixes.has(entPrefix)) return false;
      const idTokens = entPrefix.toLowerCase().split(/[_-\s]+/);
      return tokens.every(t => idTokens.includes(t));
    });
    let zonePrefix = rawPrefix;
    const sampleCal = pickSample("select", "_zone_to_calibrate") ||
                      pickSample("button", "_set_zone_corner_1") ||
                      pickSample("number", "_zone_off_delay");
    if (sampleCal) {
      const domainEnd = sampleCal.indexOf(".");
      const suffixIdx = sampleCal.indexOf("_zone_");
      if (domainEnd !== -1 && suffixIdx !== -1) {
        zonePrefix = sampleCal.slice(domainEnd + 1, suffixIdx);
      }
    }

    // Registry-backed, device-scoped lookup. Robust against mixed entity-ID naming within one
    // device (e.g. front_bedroom_presence_zone_4_* vs front_spare_bedroom_front_bedroom_presence_zone_5_*).
    let deviceIndex = null;
    let deviceEntries = null;
    const regMap = RadarEntityResolver._registryMap;
    if (regMap) {
      const anchorIds = [
        "sensor." + rawPrefix + "_target_1_x", "sensor." + canonicalPrefix + "_target_1_x",
        "sensor." + rawPrefix + "_t1_x", "sensor." + canonicalPrefix + "_t1_x"
      ];
      let deviceId = null;
      for (const id of anchorIds) {
        const e = regMap.get(id) || (hass && hass.entities && hass.entities[id]);
        if (e && e.device_id) { deviceId = e.device_id; break; }
      }
      if (deviceId) {
        deviceEntries = [];
        deviceIndex = new Map();
        for (const e of regMap.values()) {
          if (e.device_id !== deviceId) continue;
          deviceEntries.push(e);
          const domain = e.entity_id.split(".")[0];
          const nameKey = radarSlug(e.original_name || e.name);
          if (nameKey && !deviceIndex.has(domain + "." + nameKey)) {
            deviceIndex.set(domain + "." + nameKey, e.entity_id);
          }
        }
      }
    }
    const findOnDevice = (domain, key) => {
      if (!deviceIndex) return null;
      const byName = deviceIndex.get(domain + "." + key);
      if (byName) return byName;
      const suffix = "_" + key;
      const hits = deviceEntries.filter(e => e.entity_id.startsWith(domain + ".") && e.entity_id.endsWith(suffix) &&
        !(key.startsWith("zone_") && e.entity_id.includes("exclusion_" + key)));
      if (hits.length > 0) {
        hits.sort((a, b) => a.entity_id.length - b.entity_id.length);
        return hits[0].entity_id;
      }
      return null;
    };

    const findDirect = (domain, key, fallbackPrefix = canonicalPrefix) => {
      const reg = (hass && hass.entities) || {};
      if (rawPrefix && rawPrefix !== fallbackPrefix) {
        const rawDirect = domain + "." + rawPrefix + "_" + key;
        if (states[rawDirect] || reg[rawDirect]) return rawDirect;
      }
      const direct = domain + "." + fallbackPrefix + "_" + key;
      if (states[direct] || reg[direct]) return direct;
      return null;
    };

    const findEntity = (domain, key, fallbackPrefix = canonicalPrefix) => {
      const pref = key.startsWith("zone_") ? zonePrefix : fallbackPrefix;
      // 0. Device-scoped registry match (includes disabled entities)
      const onDevice = findOnDevice(domain, key);
      if (onDevice) return onDevice;
      // 1. Direct match with pref, rawPrefix, and canonicalPrefix
      const exact = findDirect(domain, key, pref) || findDirect(domain, key, rawPrefix) || findDirect(domain, key, canonicalPrefix);
      if (exact) return exact;

      // 2. Token match where ALL device tokens exist as whole tokens in entity prefix,
      // excluding entities belonging to any other discovered radar device.
      if (tokens.length > 0) {
        const suffix = "_" + key;
        const domainPrefix = domain + ".";
        const candidates = allEntityIds.filter(id => {
          if (!id.startsWith(domainPrefix) || !id.endsWith(suffix)) return false;
          if (key.startsWith("zone_") && id.includes("exclusion_" + key)) return false;
          const entPrefix = id.slice(domainPrefix.length, id.length - suffix.length);
          if (otherDevicePrefixes.has(entPrefix)) return false;
          const entTokens = entPrefix.toLowerCase().split(/[_-\s]+/);
          return tokens.every(tok => entTokens.includes(tok));
        });

        if (candidates.length > 0) {
          candidates.sort((a, b) => a.length - b.length);
          return candidates[0];
        }
      }

      return domain + "." + pref + "_" + key;
    };

    const findFirstExisting = (domain, keys) => {
      for (const k of keys) {
        const exact = findDirect(domain, k);
        if (exact) return exact;
      }
      for (const k of keys) {
        const id = findEntity(domain, k);
        if (states[id]) return id;
      }
      return findEntity(domain, keys[0]);
    };

    return {
      prefix: canonicalPrefix,
      // Target Tracking
      target1_x: findEntity("sensor", "target_1_x"),
      target1_y: findEntity("sensor", "target_1_y"),
      target1_speed: findEntity("sensor", "target_1_speed"),
      target1_angle: findEntity("sensor", "target_1_angle"),
      target1_distance: findEntity("sensor", "target_1_distance"),
      target1_resolution: findEntity("sensor", "target_1_resolution"),

      target2_x: findEntity("sensor", "target_2_x"),
      target2_y: findEntity("sensor", "target_2_y"),
      target2_speed: findEntity("sensor", "target_2_speed"),
      target2_angle: findEntity("sensor", "target_2_angle"),
      target2_distance: findEntity("sensor", "target_2_distance"),
      target2_resolution: findEntity("sensor", "target_2_resolution"),

      target3_x: findEntity("sensor", "target_3_x"),
      target3_y: findEntity("sensor", "target_3_y"),
      target3_speed: findEntity("sensor", "target_3_speed"),
      target3_angle: findEntity("sensor", "target_3_angle"),
      target3_distance: findEntity("sensor", "target_3_distance"),
      target3_resolution: findEntity("sensor", "target_3_resolution"),

      target_count: findFirstExisting("sensor", ["target_count", "active_target_count", "raw_target_count"]),
      occupancy: findFirstExisting("binary_sensor", ["occupancy", "room_occupancy"]),
      moving_target: findEntity("binary_sensor", "moving_target"),
      still_target: findEntity("binary_sensor", "still_target"),
      wifi_signal: findFirstExisting("sensor", ["wi_fi_signal", "wifi_signal", "rssi"]),
      uptime: findEntity("sensor", "uptime"),

      // Stationary latch / memory
      stationary_memory_active: findEntity("binary_sensor", "stationary_memory_active"),
      stationary_memory_switch: findEntity("switch", "stationary_presence_memory"),
      stationary_latch_timeout: findEntity("number", "stationary_latch_timeout"),

      // Room Boundaries & Sensor Placement
      mounting_angle: findEntity("number", "sensor_mounting_angle"),
      room_min_x: findEntity("number", "room_boundary_min_x"),
      room_max_x: findEntity("number", "room_boundary_max_x"),
      room_min_y: findEntity("number", "room_boundary_min_y"),
      room_max_y: findEntity("number", "room_boundary_max_y"),
      room_width: findEntity("number", "room_width"),
      room_depth: findEntity("number", "room_depth"),
      sensor_wall_offset_x: findEntity("number", "sensor_wall_offset_x"),
      apply_room_dimensions_btn: findEntity("button", "apply_room_dimensions_to_boundary"),

      // Zone Calibration Wizard & Entities
      zone_select: findEntity("select", "zone_to_calibrate"),
      zone_status: findEntity("sensor", "zone_calibration_status"),
      live_target_pos: findEntity("sensor", "live_target_position"),
      btn_corner_1: findEntity("button", "set_zone_corner_1"),
      btn_corner_2: findEntity("button", "set_zone_corner_2"),
      btn_clear_zone: findEntity("button", "clear_selected_zone"),
      calibration_padding: findEntity("number", "calibration_padding"),

      // Dynamic Active Zones (1 - 10)
      active_zones: findEntity("number", "active_zones"),

      // Zones 1 - 10 (Multi-Mode Software Zones: Detection vs Exclusion)
      zone1_occupancy: findEntity("binary_sensor", "zone_1_occupancy"),
      zone1_target_count: findEntity("sensor", "zone_1_target_count"),
      zone1_memory_active: findEntity("binary_sensor", "zone_1_memory_active"),
      zone1_x1: findEntity("number", "zone_1_x1"),
      zone1_y1: findEntity("number", "zone_1_y1"),
      zone1_x2: findEntity("number", "zone_1_x2"),
      zone1_y2: findEntity("number", "zone_1_y2"),
      zone1_angle: findEntity("number", "zone_1_angle"),
      zone1_mode: findEntity("select", "zone_1_mode"),

      zone2_occupancy: findEntity("binary_sensor", "zone_2_occupancy"),
      zone2_target_count: findEntity("sensor", "zone_2_target_count"),
      zone2_memory_active: findEntity("binary_sensor", "zone_2_memory_active"),
      zone2_x1: findEntity("number", "zone_2_x1"),
      zone2_y1: findEntity("number", "zone_2_y1"),
      zone2_x2: findEntity("number", "zone_2_x2"),
      zone2_y2: findEntity("number", "zone_2_y2"),
      zone2_angle: findEntity("number", "zone_2_angle"),
      zone2_mode: findEntity("select", "zone_2_mode"),

      zone3_occupancy: findEntity("binary_sensor", "zone_3_occupancy"),
      zone3_target_count: findEntity("sensor", "zone_3_target_count"),
      zone3_memory_active: findEntity("binary_sensor", "zone_3_memory_active"),
      zone3_x1: findEntity("number", "zone_3_x1"),
      zone3_y1: findEntity("number", "zone_3_y1"),
      zone3_x2: findEntity("number", "zone_3_x2"),
      zone3_y2: findEntity("number", "zone_3_y2"),
      zone3_angle: findEntity("number", "zone_3_angle"),
      zone3_mode: findEntity("select", "zone_3_mode"),

      zone4_occupancy: findEntity("binary_sensor", "zone_4_occupancy"),
      zone4_target_count: findEntity("sensor", "zone_4_target_count"),
      zone4_memory_active: findEntity("binary_sensor", "zone_4_memory_active"),
      zone4_x1: findEntity("number", "zone_4_x1"),
      zone4_y1: findEntity("number", "zone_4_y1"),
      zone4_x2: findEntity("number", "zone_4_x2"),
      zone4_y2: findEntity("number", "zone_4_y2"),
      zone4_angle: findEntity("number", "zone_4_angle"),
      zone4_mode: findEntity("select", "zone_4_mode"),

      zone5_occupancy: findEntity("binary_sensor", "zone_5_occupancy"),
      zone5_target_count: findEntity("sensor", "zone_5_target_count"),
      zone5_memory_active: findEntity("binary_sensor", "zone_5_memory_active"),
      zone5_x1: findEntity("number", "zone_5_x1"),
      zone5_y1: findEntity("number", "zone_5_y1"),
      zone5_x2: findEntity("number", "zone_5_x2"),
      zone5_y2: findEntity("number", "zone_5_y2"),
      zone5_angle: findEntity("number", "zone_5_angle"),
      zone5_mode: findEntity("select", "zone_5_mode"),

      zone6_occupancy: findEntity("binary_sensor", "zone_6_occupancy"),
      zone6_target_count: findEntity("sensor", "zone_6_target_count"),
      zone6_memory_active: findEntity("binary_sensor", "zone_6_memory_active"),
      zone6_x1: findEntity("number", "zone_6_x1"),
      zone6_y1: findEntity("number", "zone_6_y1"),
      zone6_x2: findEntity("number", "zone_6_x2"),
      zone6_y2: findEntity("number", "zone_6_y2"),
      zone6_angle: findEntity("number", "zone_6_angle"),
      zone6_mode: findEntity("select", "zone_6_mode"),

      zone7_occupancy: findEntity("binary_sensor", "zone_7_occupancy"),
      zone7_target_count: findEntity("sensor", "zone_7_target_count"),
      zone7_memory_active: findEntity("binary_sensor", "zone_7_memory_active"),
      zone7_x1: findEntity("number", "zone_7_x1"),
      zone7_y1: findEntity("number", "zone_7_y1"),
      zone7_x2: findEntity("number", "zone_7_x2"),
      zone7_y2: findEntity("number", "zone_7_y2"),
      zone7_angle: findEntity("number", "zone_7_angle"),
      zone7_mode: findEntity("select", "zone_7_mode"),

      zone8_occupancy: findEntity("binary_sensor", "zone_8_occupancy"),
      zone8_target_count: findEntity("sensor", "zone_8_target_count"),
      zone8_memory_active: findEntity("binary_sensor", "zone_8_memory_active"),
      zone8_x1: findEntity("number", "zone_8_x1"),
      zone8_y1: findEntity("number", "zone_8_y1"),
      zone8_x2: findEntity("number", "zone_8_x2"),
      zone8_y2: findEntity("number", "zone_8_y2"),
      zone8_angle: findEntity("number", "zone_8_angle"),
      zone8_mode: findEntity("select", "zone_8_mode"),

      zone9_occupancy: findEntity("binary_sensor", "zone_9_occupancy"),
      zone9_target_count: findEntity("sensor", "zone_9_target_count"),
      zone9_memory_active: findEntity("binary_sensor", "zone_9_memory_active"),
      zone9_x1: findEntity("number", "zone_9_x1"),
      zone9_y1: findEntity("number", "zone_9_y1"),
      zone9_x2: findEntity("number", "zone_9_x2"),
      zone9_y2: findEntity("number", "zone_9_y2"),
      zone9_angle: findEntity("number", "zone_9_angle"),
      zone9_mode: findEntity("select", "zone_9_mode"),

      zone10_occupancy: findEntity("binary_sensor", "zone_10_occupancy"),
      zone10_target_count: findEntity("sensor", "zone_10_target_count"),
      zone10_memory_active: findEntity("binary_sensor", "zone_10_memory_active"),
      zone10_x1: findEntity("number", "zone_10_x1"),
      zone10_y1: findEntity("number", "zone_10_y1"),
      zone10_x2: findEntity("number", "zone_10_x2"),
      zone10_y2: findEntity("number", "zone_10_y2"),
      zone10_angle: findEntity("number", "zone_10_angle"),
      zone10_mode: findEntity("select", "zone_10_mode"),

      // Engine Tuning & Sensitivity
      presence_timeout: findEntity("number", "presence_timeout"),
      zone_off_delay: findEntity("number", "zone_off_delay"),
      max_distance: findEntity("number", "max_distance"),
      exit_trajectory_margin: findEntity("number", "exit_trajectory_margin"),
      multi_target: findEntity("switch", "multi_target_tracking"),
      invert_x_switch: findFirstExisting("switch", ["invert_x_axis_upside_down_mount", "invert_x_axis", "invert_x"]),
      restart_esp: findEntity("button", "restart_esp32"),
      restart_radar: findEntity("button", "restart_radar"),
      factory_reset_radar: findEntity("button", "factory_reset_radar"),

      // Firmware Version Parity & HA Update Entity
      suite_version: findFirstExisting("sensor", ["radar_suite_version", "suite_version"]),
      firmware_update: findFirstExisting("update", ["firmware", "update"])
    };
  }

  static isZoneConfigured(hass, entities, z) {
    if (!entities) return false;
    const states = (hass && hass.states) || {};
    const getNum = (id) => {
      if (!id || !states[id]) return 0;
      const v = parseFloat(states[id].state);
      return isNaN(v) ? 0 : v;
    };
    const x1 = getNum(entities[`zone${z}_x1`]);
    const y1 = getNum(entities[`zone${z}_y1`]);
    const x2 = getNum(entities[`zone${z}_x2`]);
    const y2 = getNum(entities[`zone${z}_y2`]);
    return !(x1 === 0 && y1 === 0 && x2 === 0 && y2 === 0);
  }

  static isZoneRegistryDisabled(entities, z) {
    if (!entities || !this._registryMap) return null;
    const occId = entities[`zone${z}_occupancy`];
    if (!occId || !this._registryMap.has(occId)) return null;
    return Boolean(this._registryMap.get(occId).disabled_by);
  }

  static isZoneEnabled(hass, entities, z) {
    if (!entities) return false;
    const occId = entities[`zone${z}_occupancy`];
    if (!occId) return false;
    const regDisabled = this.isZoneRegistryDisabled(entities, z);
    if (regDisabled !== null) return !regDisabled;
    if (hass && hass.entities && hass.entities[occId]) {
      return !hass.entities[occId].disabled;
    }
    const states = (hass && hass.states) || {};
    return Boolean(states[occId] && states[occId].state !== "unavailable");
  }

  static isZoneActive(hass, entities, z, locallyEnabled = null) {
    if (locallyEnabled && locallyEnabled.has(z)) return true;
    // A zone explicitly disabled in the HA registry is never active, even if stale coordinates linger
    if (this.isZoneRegistryDisabled(entities, z) === true) return false;
    return this.isZoneConfigured(hass, entities, z) || this.isZoneEnabled(hass, entities, z);
  }

  static getActiveZones(hass, entities, locallyEnabled = null) {
    const list = [];
    for (let z = 1; z <= 10; z++) {
      if (this.isZoneActive(hass, entities, z, locallyEnabled)) {
        list.push(z);
      }
    }
    return list;
  }
}

// ====================================================================
// VISIBILITY MANAGER: Dynamic Enable / Disable of Zone Entities in HA
// ====================================================================
class RadarVisibilityManager {
  static getZoneEntities(entities, z) {
    if (!entities) return [];
    return [
      entities[`zone${z}_occupancy`],
      entities[`zone${z}_target_count`],
      entities[`zone${z}_memory_active`],
      entities[`zone${z}_x1`],
      entities[`zone${z}_y1`],
      entities[`zone${z}_x2`],
      entities[`zone${z}_y2`],
      entities[`zone${z}_angle`],
      entities[`zone${z}_mode`]
    ].filter(Boolean);
  }

  static canEditRegistry(hass) {
    return !(hass && hass.user && hass.user.is_admin === false);
  }

  // Updates all entities of a zone in parallel. Returns { ok, okCount, total, configEntryId }.
  static async _setZoneDisabled(hass, entities, z, disabledBy) {
    const regMap = RadarEntityResolver._registryMap;
    const all = this.getZoneEntities(entities, z);
    // Only touch entities that really exist in the registry (when we know it)
    const targets = regMap ? all.filter(id => regMap.has(id)) : all;
    if (targets.length === 0) return { ok: false, reason: "notfound", okCount: 0, total: 0, configEntryId: null };

    let configEntryId = null;
    const results = await Promise.all(targets.map(async (entityId) => {
      const before = regMap ? regMap.get(entityId) : null;
      if (!configEntryId && before && before.config_entry_id) configEntryId = before.config_entry_id;
      try {
        const res = await hass.callWS({
          type: "config/entity_registry/update",
          entity_id: entityId,
          disabled_by: disabledBy
        });
        const entry = (res && res.entity_entry) ? res.entity_entry : null;
        if (!configEntryId && entry && entry.config_entry_id) configEntryId = entry.config_entry_id;
        if (regMap) {
          regMap.set(entityId, Object.assign({}, before || {}, entry || {}, { disabled_by: disabledBy }));
        }
        return true;
      } catch (e) {
        console.warn(`[PRESENCE-RADAR-CARDS] Failed to set disabled_by=${disabledBy} on`, entityId, e);
        return false;
      }
    }));
    const okCount = results.filter(Boolean).length;
    return { ok: okCount === targets.length, reason: okCount ? null : "failed", okCount, total: targets.length, configEntryId };
  }

  static async enableZone(hass, entities, z) {
    if (!hass || !entities || !hass.callWS) return { ok: false, reason: "unavailable", okCount: 0, total: 0 };
    if (!this.canEditRegistry(hass)) return { ok: false, reason: "admin", okCount: 0, total: 0 };
    const res = await this._setZoneDisabled(hass, entities, z, null);
    RadarEntityResolver._notifyRegistry();

    // ONE immediate integration reload so ESPHome creates the newly enabled entities (fire-and-forget).
    // HA also schedules its own reload ~30s later; last-known-good caching keeps the UI stable through both.
    if (res.okCount > 0 && hass.callService) {
      let p = null;
      if (res.configEntryId) {
        p = hass.callService("homeassistant", "reload_config_entry", { entry_id: res.configEntryId });
      } else if (entities.target1_x) {
        p = hass.callService("homeassistant", "reload_config_entry", {}, { entity_id: entities.target1_x });
      }
      if (p && p.catch) p.catch(e => console.warn("[PRESENCE-RADAR-CARDS] reload_config_entry failed", e));
    }
    return res;
  }

  static async disableZone(hass, entities, z) {
    if (!hass || !entities || !hass.callWS) return { ok: false, reason: "unavailable", okCount: 0, total: 0 };
    if (!this.canEditRegistry(hass)) return { ok: false, reason: "admin", okCount: 0, total: 0 };
    const res = await this._setZoneDisabled(hass, entities, z, "user");
    // HA removes disabled entities immediately - no integration reload needed.
    radarForgetStates(this.getZoneEntities(entities, z));
    RadarEntityResolver._notifyRegistry();
    return res;
  }
}

// ====================================================================
// ROOM GEOMETRY ENGINE: True Wall Coordinates & Angular Transforms
// ====================================================================
class RoomGeometry {
  static compute(config, resolvedEntities, hass) {
    const states = (hass && hass.states) || {};
    const getVal = (id, def) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return isNaN(v) ? def : v;
    };

    // Priority 1: Sensor ESPHome entities (configured on ESP32)
    let roomWidth = 0;
    let roomDepth = 0;
    let sensorOffsetX = 0;
    let mountingAngle = 0;

    if (resolvedEntities.room_width && states[resolvedEntities.room_width]) {
      roomWidth = getVal(resolvedEntities.room_width, 0);
    }
    if (resolvedEntities.room_depth && states[resolvedEntities.room_depth]) {
      roomDepth = getVal(resolvedEntities.room_depth, 0);
    }
    if (resolvedEntities.sensor_wall_offset_x && states[resolvedEntities.sensor_wall_offset_x]) {
      sensorOffsetX = getVal(resolvedEntities.sensor_wall_offset_x, 0);
    }
    if (resolvedEntities.mounting_angle && states[resolvedEntities.mounting_angle]) {
      mountingAngle = getVal(resolvedEntities.mounting_angle, 0);
    }

    // Priority 2: Fallback from radar boundaries min_x/max_x/max_y
    if (!roomWidth || !roomDepth) {
      const minX = getVal(resolvedEntities.room_min_x, -2500);
      const maxX = getVal(resolvedEntities.room_max_x, 2500);
      const maxY = getVal(resolvedEntities.room_max_y, 5000);
      if (!roomWidth) roomWidth = Math.abs(maxX - minX) || 5000;
      if (!roomDepth) roomDepth = maxY || 5000;
    }

    // Priority 3: Optional YAML config overrides if explicitly specified
    if (config && config.room_width) roomWidth = parseFloat(config.room_width);
    if (config && config.room_depth) roomDepth = parseFloat(config.room_depth);
    if (config && config.sensor_offset_x !== undefined) sensorOffsetX = parseFloat(config.sensor_offset_x);
    if (config && config.mounting_angle !== undefined) mountingAngle = parseFloat(config.mounting_angle);

    // Optional X-Axis Mirror for Upside-Down (180-deg Rolled) Sensor Enclosures
    let invertX = false;
    if (resolvedEntities.invert_x_switch && states[resolvedEntities.invert_x_switch]) {
      invertX = states[resolvedEntities.invert_x_switch].state === "on";
    }
    if (config && config.invert_x !== undefined) {
      invertX = Boolean(config.invert_x);
    }

    // Compute Sensor Wall Coordinate (sx, sy) relative to room front-left corner (0, 0)
    const cleanWidth = Math.max(1000, roomWidth);
    const cleanDepth = Math.max(1000, roomDepth);
    const sx = cleanWidth / 2 + sensorOffsetX;
    const sy = 0; // Front wall (Y = 0)

    return {
      hasRoom: true,
      roomWidth: cleanWidth,
      roomDepth: cleanDepth,
      sx: sx,
      sy: sy,
      angle: mountingAngle,
      sensorOffsetX: sensorOffsetX,
      invertX: invertX
    };
  }

  // Frame 1 (raw LD2450 chip) -> Frame 2 (sensor-origin, room-wall-aligned)
  // Matches ESPHome presence_memory::sensor_raw_to_room_aligned(rx, ry, mount_yaw, invert_x)
  // Raw LD2450 +X is to the sensor's own right (looking out from the sensor into the room).
  // On a top-down room floorplan with the front mounting wall at the top (Y=0) and +Y extending
  // down into the room, the sensor's right points LEFT (-X), so standard upright mounts negate
  // raw X (lx = -xr_mm). Upside-down 180-deg rolled mounts (invertX = true) keep +xr_mm.
  static rotateToRoomAligned(xr_mm, yr_mm, angleDeg = 0, invertX = false) {
    const lx = invertX ? xr_mm : -xr_mm;
    if (!angleDeg) {
      return { x: lx, y: yr_mm };
    }
    const rad = (angleDeg * Math.PI) / 180.0;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    return {
      x: lx * cosA - yr_mm * sinA,
      y: lx * sinA + yr_mm * cosA
    };
  }

  // Frame 1 (raw LD2450 chip) -> Frame 3 (SVG room coordinates)
  // Used for raw live targets (T1..T3) and hardware exclusion masks (Mask 1..3)
  static transformPoint(xr_mm, yr_mm, geom, invertX = false, invertY = false) {
    const effInvertX = Boolean((geom && geom.invertX) ? !invertX : invertX);
    const yr = invertY ? -yr_mm : yr_mm;

    if (!geom) {
      return { x: effInvertX ? xr_mm : -xr_mm, y: yr };
    }

    const rot = this.rotateToRoomAligned(xr_mm, yr, geom.angle || 0, effInvertX);
    return {
      x: geom.sx + rot.x,
      y: geom.sy + rot.y
    };
  }

  // Frame 2 (sensor-origin, ALREADY rotated by mount_yaw on ESP32) -> Frame 3 (SVG room coordinates)
  // Used for Software Detection Zones (Zone 1..4): applies only local zone rotation zAngle + sensor wall translation!
  static transformZonePolygon(xr1, yr1, xr2, yr2, zAngle = 0, geom) {
    if (!geom) return [];
    const minX = Math.min(xr1, xr2);
    const maxX = Math.max(xr1, xr2);
    const minY = Math.min(yr1, yr2);
    const maxY = Math.max(yr1, yr2);

    let corners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];

    if (zAngle !== 0) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const zRad = (zAngle * Math.PI) / 180.0;
      const cosZ = Math.cos(zRad);
      const sinZ = Math.sin(zRad);

      corners = corners.map(c => {
        const dx = c.x - cx;
        const dy = c.y - cy;
        return {
          x: cx + dx * cosZ - dy * sinZ,
          y: cy + dx * sinZ + dy * cosZ
        };
      });
    }

    return corners.map(c => ({
      x: geom.sx + c.x,
      y: geom.sy + c.y
    }));
  }

  // Frame 1 (raw unrotated LD2450 chip NVRAM) -> Frame 3 (SVG room coordinates)
  // Used for Hardware Exclusion Masks (Mask 1..3), which the LD2450 chip evaluates before mount_yaw rotation.
  static transformMaskPolygon(mx1, my1, mx2, my2, geom) {
    if (!geom) return [];
    const minX = Math.min(mx1, mx2);
    const maxX = Math.max(mx1, mx2);
    const minY = Math.min(my1, my2);
    const maxY = Math.max(my1, my2);

    const corners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];

    return corners.map(c => this.transformPoint(c.x, c.y, geom));
  }

  static transformPolygon(xr1, yr1, xr2, yr2, zAngle = 0, geom, invertX = false, invertY = false) {
    return this.transformZonePolygon(xr1, yr1, xr2, yr2, zAngle, geom);
  }
}

if (typeof window !== "undefined") {
  window.RadarEntityResolver = RadarEntityResolver;
  window.RoomGeometry = RoomGeometry;
}



// ====================================================================
// FLOORPLAN MANAGER: Per-Sensor Image Overlay, Scaling & Live Setup
// ====================================================================
class RadarFloorplanManager {
  static getFloorplan(config, device) {
    if (!device) return null;
    // 1. Check card config dictionary
    if (config && config.floorplans && config.floorplans[device]) {
      return config.floorplans[device];
    }
    // 2. Check localStorage for browser-level persistence
    try {
      const local = localStorage.getItem(`presence_radar_fp_${device}`);
      if (local) {
        return JSON.parse(local);
      }
    } catch (_) {}
    // 3. Fallback to root level config
    if (config && (config.floorplan_image || (config.floorplan && config.floorplan.image))) {
      return {
        image: config.floorplan_image || config.floorplan.image,
        opacity: config.floorplan_opacity !== undefined ? config.floorplan_opacity : (config.floorplan?.opacity || 0.45),
        fit: config.floorplan_fit || config.floorplan?.fit || "room",
        width: config.floorplan_width || config.floorplan?.width || 0,
        depth: config.floorplan_depth || config.floorplan?.depth || 0,
        offsetX: config.floorplan_offset_x || config.floorplan?.offsetX || 0,
        offsetY: config.floorplan_offset_y || config.floorplan?.offsetY || 0
      };
    }
    return null;
  }

  static saveFloorplan(device, fpData, cardOrEditorInstance) {
    if (!device) return;
    try {
      if (fpData && fpData.image) {
        localStorage.setItem(`presence_radar_fp_${device}`, JSON.stringify(fpData));
      } else {
        localStorage.removeItem(`presence_radar_fp_${device}`);
      }
    } catch (_) {}

    if (cardOrEditorInstance && cardOrEditorInstance._config) {
      const newConfig = Object.assign({}, cardOrEditorInstance._config);
      newConfig.floorplans = Object.assign({}, newConfig.floorplans);
      if (fpData && fpData.image) {
        newConfig.floorplans[device] = Object.assign({}, fpData);
      } else {
        delete newConfig.floorplans[device];
      }
      cardOrEditorInstance._config = newConfig;
      cardOrEditorInstance.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: newConfig },
        bubbles: true,
        composed: true
      }));
    }
  }

  static renderFloorplanSvg(fp, geom, clipId) {
    if (!fp || !fp.image) return "";
    const opacity = (fp.opacity !== undefined && fp.opacity !== null) ? parseFloat(fp.opacity) : 0.45;
    let x = 0, y = 0, w = geom.roomWidth, d = geom.roomDepth;
    if (fp.fit === "custom") {
      x = parseFloat(fp.offsetX) || 0;
      y = parseFloat(fp.offsetY) || 0;
      w = parseFloat(fp.width) || geom.roomWidth;
      d = parseFloat(fp.depth) || geom.roomDepth;
    }
    const clipAttr = clipId ? `clip-path="url(#${clipId})"` : "";
    return `
      <!-- Dark room backing under floorplan for smooth blending when opacity < 1 -->
      <rect x="0" y="0" width="${geom.roomWidth}" height="${geom.roomDepth}"
            fill="rgba(15, 23, 42, 0.6)" rx="6" />
      <g id="floorplanContainer" ${clipAttr} pointer-events="none">
        <image href="${fp.image}" x="${x}" y="${y}" width="${w}" height="${d}"
               opacity="${opacity}" preserveAspectRatio="none" />
      </g>
    `;
  }

  // ==================================================================
  // GUI CARD EDITOR INTEGRATION (Both Cards)
  // ==================================================================
  static _processImageFile(file, callback) {
    if (!file) return;
    const reader = new FileReader();
    if (file.type === "image/svg+xml" || file.name.endsWith(".svg")) {
      reader.onload = (e) => callback(e.target.result);
      reader.readAsDataURL(file);
      return;
    }
    reader.onload = (e) => {
      if (typeof Image === "undefined" || typeof document === "undefined") {
        callback(e.target.result);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
          const dataUrl = canvas.toDataURL(outType, 0.85);
          callback(dataUrl);
        } catch (_) {
          callback(e.target.result);
        }
      };
      img.onerror = () => callback(e.target.result);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  static renderEditorSection(idPrefix = "fpEdit") {
    return `
      <div style="border-top:1px solid rgba(255,255,255,0.12); padding-top:14px; margin-top:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <label style="font-size:0.9rem; font-weight:700; display:flex; align-items:center; gap:6px;">
            <span>🖼️</span> <span id="${idPrefix}TitleLabel">Floorplan Overlay (Per-Sensor)</span>
          </label>
          <span id="${idPrefix}ActiveBadge" style="display:none; font-size:0.72rem; padding:2px 8px; border-radius:10px; background:rgba(56,189,248,0.15); color:#38bdf8; font-weight:600;">
            Configured
          </span>
        </div>
        <div id="${idPrefix}SubDesc" style="font-size:0.75rem; color:var(--secondary-text-color, #94a3b8); margin-bottom:12px; line-height:1.4;">
          Display an architectural floorplan or room map under the radar beam. Configured per sensor so switching sensors in the dropdown dynamically switches the floorplan.
        </div>

        <div id="${idPrefix}DeviceRow" style="margin-bottom:12px;">
          <label style="display:block; font-size:0.82rem; font-weight:600; margin-bottom:4px;">Configure Floorplan For Sensor</label>
          <select id="${idPrefix}DeviceSelect" style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2);">
            <option value="">Select a sensor...</option>
          </select>
        </div>

        <div style="margin-bottom:12px;">
          <label style="display:block; font-size:0.82rem; font-weight:600; margin-bottom:5px;">Floorplan Image Selection</label>
          
          <!-- File Selector & Preset Picker Actions -->
          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <input type="file" id="${idPrefix}FileInput" accept="image/*,.svg,.png,.jpg,.jpeg,.webp" style="display:none;" />
            <button type="button" id="${idPrefix}BtnChooseFile" style="display:inline-flex; align-items:center; gap:6px; padding:7px 14px; background:rgba(56,189,248,0.16); border:1px solid rgba(56,189,248,0.45); color:#38bdf8; border-radius:6px; font-size:0.82rem; font-weight:600; cursor:pointer;">
              📁 Choose File from Device
            </button>
            <select id="${idPrefix}PresetSelect" style="flex:1; min-width:180px; padding:7px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2); font-size:0.82rem;">
              <option value="">Or pick local floorplan preset...</option>
              <option value="/local/test_floorplan.svg">✨ Test Floorplan 4x5m (/local/test_floorplan.svg)</option>
              <option value="/local/floorplan/downstairs/living-room/living-room-day.png">🛋️ Living Room (/local/floorplan/...)</option>
              <option value="/local/floorplan/downstairs/kitchen/kitchen-day.png">🍳 Kitchen (/local/floorplan/...)</option>
              <option value="/local/floorplan/downstairs/entryway/entryway-day.png">🚪 Entryway (/local/floorplan/...)</option>
              <option value="/local/floorplan/downstairs/garage/garage-day.png">🚗 Garage (/local/floorplan/...)</option>
            </select>
          </div>

          <!-- URL / Path Input -->
          <input type="text" id="${idPrefix}ImageInput" placeholder="URL, local path, or chosen file..."
                 style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2); box-sizing:border-box; font-size:0.82rem;" />
          <div id="${idPrefix}FileStatus" style="font-size:0.72rem; color:var(--secondary-text-color, #94a3b8); margin-top:4px;">
            Choose a file from your device, select a local preset, or enter any <code>/local/...</code> path.
          </div>
        </div>

        <div style="margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <label style="font-size:0.82rem; font-weight:600;">Overlay Opacity</label>
            <span id="${idPrefix}OpacityLabel" style="font-size:0.82rem; font-weight:700; color:var(--primary-color, #38bdf8);">45%</span>
          </div>
          <input type="range" id="${idPrefix}OpacityRange" min="0" max="100" value="45"
                 style="width:100%; cursor:pointer; accent-color:var(--primary-color, #38bdf8);" />
        </div>

        <div style="margin-bottom:12px;">
          <label style="display:block; font-size:0.82rem; font-weight:600; margin-bottom:4px;">Scale & Fit Mode</label>
          <select id="${idPrefix}FitSelect" style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2);">
            <option value="room">Fit to Room Boundaries (Automatic Width & Depth)</option>
            <option value="custom">Custom Dimensions & Offset (Advanced)</option>
          </select>
        </div>

        <div id="${idPrefix}CustomBox" style="display:none; padding:10px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); margin-bottom:12px;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <div>
              <label style="display:block; font-size:0.75rem; margin-bottom:2px;">Width (mm)</label>
              <input type="number" id="${idPrefix}Width" placeholder="4000" style="width:100%; padding:6px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.15); box-sizing:border-box;" />
            </div>
            <div>
              <label style="display:block; font-size:0.75rem; margin-bottom:2px;">Depth (mm)</label>
              <input type="number" id="${idPrefix}Depth" placeholder="5000" style="width:100%; padding:6px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.15); box-sizing:border-box;" />
            </div>
            <div>
              <label style="display:block; font-size:0.75rem; margin-bottom:2px;">Offset X (mm)</label>
              <input type="number" id="${idPrefix}OffsetX" placeholder="0" style="width:100%; padding:6px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.15); box-sizing:border-box;" />
            </div>
            <div>
              <label style="display:block; font-size:0.75rem; margin-bottom:2px;">Offset Y (mm)</label>
              <input type="number" id="${idPrefix}OffsetY" placeholder="0" style="width:100%; padding:6px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:#fff; border:1px solid rgba(255,255,255,0.15); box-sizing:border-box;" />
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end;">
          <button type="button" id="${idPrefix}BtnClear" style="padding:6px 12px; font-size:0.78rem; background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); border-radius:6px; cursor:pointer;">
            🗑️ Clear Floorplan
          </button>
        </div>
      </div>
    `;
  }

  static attachEditorEvents(container, idPrefix = "fpEdit", editorInstance) {
    if (!container) return;
    const selDev = container.querySelector(`#${idPrefix}DeviceSelect`);
    const btnChoose = container.querySelector(`#${idPrefix}BtnChooseFile`);
    const fileInp = container.querySelector(`#${idPrefix}FileInput`);
    const presetSel = container.querySelector(`#${idPrefix}PresetSelect`);
    const inpImg = container.querySelector(`#${idPrefix}ImageInput`);
    const statusLbl = container.querySelector(`#${idPrefix}FileStatus`);
    const rngOpacity = container.querySelector(`#${idPrefix}OpacityRange`);
    const lblOpacity = container.querySelector(`#${idPrefix}OpacityLabel`);
    const selFit = container.querySelector(`#${idPrefix}FitSelect`);
    const customBox = container.querySelector(`#${idPrefix}CustomBox`);
    const inpW = container.querySelector(`#${idPrefix}Width`);
    const inpD = container.querySelector(`#${idPrefix}Depth`);
    const inpX = container.querySelector(`#${idPrefix}OffsetX`);
    const inpY = container.querySelector(`#${idPrefix}OffsetY`);
    const btnClear = container.querySelector(`#${idPrefix}BtnClear`);

    const getActiveDevice = () => {
      const pinned = editorInstance._config && editorInstance._config.device;
      if (pinned && pinned.trim() !== "") return pinned.trim();
      return selDev ? selDev.value : "";
    };

    if (selDev) {
      selDev.addEventListener("change", () => {
        RadarFloorplanManager._populateEditorFields(container, idPrefix, editorInstance, selDev.value);
      });
    }

    if (rngOpacity && lblOpacity) {
      rngOpacity.addEventListener("input", () => {
        lblOpacity.textContent = `${rngOpacity.value}%`;
      });
    }

    if (selFit && customBox) {
      selFit.addEventListener("change", () => {
        customBox.style.display = selFit.value === "custom" ? "block" : "none";
      });
    }

    const saveFromEditor = () => {
      const dev = getActiveDevice();
      if (!dev) return;

      const imgVal = inpImg ? inpImg.value.trim() : "";
      let fpData = null;
      if (imgVal) {
        const opVal = (rngOpacity ? parseInt(rngOpacity.value, 10) : 45) / 100.0;
        const fitVal = selFit ? selFit.value : "room";
        fpData = {
          image: imgVal,
          opacity: opVal,
          fit: fitVal
        };
        if (fitVal === "custom") {
          fpData.width = inpW ? parseFloat(inpW.value) || 0 : 0;
          fpData.depth = inpD ? parseFloat(inpD.value) || 0 : 0;
          fpData.offsetX = inpX ? parseFloat(inpX.value) || 0 : 0;
          fpData.offsetY = inpY ? parseFloat(inpY.value) || 0 : 0;
        }
      }

      RadarFloorplanManager.saveFloorplan(dev, fpData, editorInstance);
      const badge = container.querySelector(`#${idPrefix}ActiveBadge`);
      if (badge) {
        badge.style.display = fpData ? "inline-block" : "none";
      }
    };

    // File Input Picker
    if (btnChoose && fileInp) {
      btnChoose.addEventListener("click", () => fileInp.click());
      fileInp.addEventListener("change", () => {
        const file = fileInp.files && fileInp.files[0];
        if (!file) return;
        if (statusLbl) statusLbl.textContent = `⏳ Loading ${file.name}...`;
        RadarFloorplanManager._processImageFile(file, (dataUrl) => {
          if (inpImg) inpImg.value = dataUrl;
          if (presetSel) presetSel.value = "";
          if (statusLbl) statusLbl.textContent = `✅ Loaded: ${file.name} (${Math.round(file.size / 1024)} KB)`;
          saveFromEditor();
        });
      });
    }

    // Preset Dropdown Picker
    if (presetSel) {
      presetSel.addEventListener("change", () => {
        const val = presetSel.value;
        if (!val) return;
        if (inpImg) inpImg.value = val;
        if (statusLbl) statusLbl.textContent = `✅ Selected preset: ${val}`;
        saveFromEditor();
      });
    }

    [inpImg, rngOpacity, selFit, inpW, inpD, inpX, inpY].forEach(el => {
      if (el) {
        el.addEventListener("input", saveFromEditor);
        el.addEventListener("change", saveFromEditor);
      }
    });

    if (btnClear) {
      btnClear.addEventListener("click", () => {
        const dev = getActiveDevice();
        if (!dev) return;
        RadarFloorplanManager.saveFloorplan(dev, null, editorInstance);
        RadarFloorplanManager._populateEditorFields(container, idPrefix, editorInstance, dev);
      });
    }
  }

  static _populateEditorFields(container, idPrefix, editorInstance, device) {
    if (!container) return;
    const inpImg = container.querySelector(`#${idPrefix}ImageInput`);
    const presetSel = container.querySelector(`#${idPrefix}PresetSelect`);
    const statusLbl = container.querySelector(`#${idPrefix}FileStatus`);
    const rngOpacity = container.querySelector(`#${idPrefix}OpacityRange`);
    const lblOpacity = container.querySelector(`#${idPrefix}OpacityLabel`);
    const selFit = container.querySelector(`#${idPrefix}FitSelect`);
    const customBox = container.querySelector(`#${idPrefix}CustomBox`);
    const inpW = container.querySelector(`#${idPrefix}Width`);
    const inpD = container.querySelector(`#${idPrefix}Depth`);
    const inpX = container.querySelector(`#${idPrefix}OffsetX`);
    const inpY = container.querySelector(`#${idPrefix}OffsetY`);
    const badge = container.querySelector(`#${idPrefix}ActiveBadge`);

    const fp = device ? RadarFloorplanManager.getFloorplan(editorInstance._config, device) : null;

    const hasDoc = typeof document !== "undefined";
    const imgVal = (fp && fp.image) || "";

    if (inpImg && (!hasDoc || document.activeElement !== inpImg)) {
      inpImg.value = imgVal;
    }
    if (presetSel && (!hasDoc || document.activeElement !== presetSel)) {
      presetSel.value = (presetSel.querySelector(`option[value="${imgVal}"]`) ? imgVal : "");
    }
    if (statusLbl) {
      if (imgVal.startsWith("data:")) {
        statusLbl.textContent = "✅ Image file loaded directly from device";
      } else if (imgVal) {
        statusLbl.textContent = `✅ Active: ${imgVal}`;
      } else {
        statusLbl.innerHTML = "Choose a file from your device, select a local preset, or enter any <code>/local/...</code> path.";
      }
    }

    const op = fp && fp.opacity !== undefined ? Math.round(fp.opacity * 100) : 45;
    if (rngOpacity && (!hasDoc || document.activeElement !== rngOpacity)) {
      rngOpacity.value = op;
    }
    if (lblOpacity) {
      lblOpacity.textContent = `${op}%`;
    }
    const isCustom = Boolean(fp && fp.fit === "custom");
    if (selFit && (!hasDoc || document.activeElement !== selFit)) {
      selFit.value = isCustom ? "custom" : "room";
    }
    if (customBox) {
      customBox.style.display = isCustom ? "block" : "none";
    }
    if (inpW && (!hasDoc || document.activeElement !== inpW)) {
      inpW.value = (fp && fp.width) || "";
    }
    if (inpD && (!hasDoc || document.activeElement !== inpD)) {
      inpD.value = (fp && fp.depth) || "";
    }
    if (inpX && (!hasDoc || document.activeElement !== inpX)) {
      inpX.value = (fp && fp.offsetX) || "";
    }
    if (inpY && (!hasDoc || document.activeElement !== inpY)) {
      inpY.value = (fp && fp.offsetY) || "";
    }
    if (badge) {
      badge.style.display = (fp && fp.image) ? "inline-block" : "none";
    }
  }

  static updateEditorForm(container, idPrefix = "fpEdit", editorInstance) {
    if (!container) return;
    const devRow = container.querySelector(`#${idPrefix}DeviceRow`);
    const selDev = container.querySelector(`#${idPrefix}DeviceSelect`);
    const titleLbl = container.querySelector(`#${idPrefix}TitleLabel`);
    const subDesc = container.querySelector(`#${idPrefix}SubDesc`);
    const btnClear = container.querySelector(`#${idPrefix}BtnClear`);

    const pinnedDev = editorInstance._config && editorInstance._config.device;
    const hasPinned = Boolean(pinnedDev && pinnedDev.trim() !== "");

    if (devRow) {
      devRow.style.display = hasPinned ? "none" : "block";
    }
    if (titleLbl) {
      titleLbl.textContent = hasPinned ? "Floorplan Overlay" : "Floorplan Overlay (Per-Sensor)";
    }
    if (subDesc) {
      subDesc.textContent = hasPinned
        ? "Display an architectural floorplan or room map under the radar beam for this sensor."
        : "Display an architectural floorplan or room map under the radar beam. Configured per sensor so switching sensors in the dropdown dynamically switches the floorplan.";
    }
    if (btnClear) {
      btnClear.textContent = hasPinned ? "🗑️ Clear Floorplan" : "🗑️ Clear Floorplan for Selected Sensor";
    }

    if (!editorInstance._hass) return;

    const devices = RadarEntityResolver.getDevices(editorInstance._hass);
    let targetDevice = "";

    if (hasPinned) {
      targetDevice = pinnedDev;
      if (selDev) selDev.value = pinnedDev;
    } else {
      const prevVal = selDev ? selDev.value : "";
      if (prevVal && devices.some(d => d.prefix === prevVal)) {
        targetDevice = prevVal;
      } else if (devices.length > 0) {
        targetDevice = devices[0].prefix;
      }
      if (selDev) {
        selDev.innerHTML = devices.length === 0
          ? `<option value="">No presence sensors discovered</option>`
          : devices.map(d => `<option value="${d.prefix}" ${d.prefix === targetDevice ? "selected" : ""}>${d.name} (${d.prefix})</option>`).join("");
        selDev.value = targetDevice;
      }
    }

    RadarFloorplanManager._populateEditorFields(container, idPrefix, editorInstance, targetDevice);
  }
}

if (typeof window !== "undefined") {
  window.RadarFloorplanManager = RadarFloorplanManager;
}

// ====================================================================
// GUI EDITOR: RADAR MAP CARD EDITOR (Single-Render, Focus Preserving)
// ====================================================================
class RadarMapCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({}, config);
    if (!this._rendered) {
      this._render();
    } else {
      this._updateFormValues();
    }
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;
    if (!this._rendered) {
      this._render();
    } else if (!oldHass) {
      this._updateDeviceOptions();
    }
  }

  _render() {
    if (!this._config) return;
    this._rendered = true;

    this.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px; padding:8px 0; font-family:var(--ha-font-family, sans-serif);">
        <div>
          <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:5px;">Select Presence Sensor</label>
          <select id="editorDeviceSelect" style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2);">
            <option value="">Select on drop-down</option>
          </select>
          <div style="font-size:0.75rem; color:var(--secondary-text-color, #94a3b8); margin-top:4px;">
            Choose a specific room to pin this card, or keep "Select on drop-down" to switch sensors directly from the card header.
          </div>
        </div>

        <div>
          <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:5px;">Card Title</label>
          <input type="text" id="editorTitleInput" value="${this._config.title || "Presence Radar Map"}"
                 style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2); box-sizing:border-box;" />
        </div>

        <div>
          <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:5px;">Card Layout</label>
          <select id="editorLayoutSelect" style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2);">
            <option value="full" ${this._config.layout_mode !== "minimal" ? "selected" : ""}>Full (Radar View + Targets + Zones)</option>
            <option value="minimal" ${this._config.layout_mode === "minimal" ? "selected" : ""}>Minimal (Radar View Only)</option>
          </select>
        </div>

        ${RadarFloorplanManager.renderEditorSection("mapFpEdit")}
      </div>
    `;

    this._updateDeviceOptions();

    const selDevice = this.querySelector("#editorDeviceSelect");
    const inpTitle = this.querySelector("#editorTitleInput");
    const selLayout = this.querySelector("#editorLayoutSelect");

    const notify = () => {
      const newConfig = Object.assign({}, this._config, {
        device: selDevice.value,
        title: inpTitle.value,
        layout_mode: selLayout.value
      });
      this._config = newConfig;
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: newConfig },
        bubbles: true,
        composed: true
      }));
    };

    selDevice.addEventListener("change", () => {
      notify();
      const fpDevSel = this.querySelector("#mapFpEditDeviceSelect");
      if (fpDevSel && selDevice.value) {
        fpDevSel.value = selDevice.value;
        RadarFloorplanManager.updateEditorForm(this, "mapFpEdit", this);
      }
    });
    inpTitle.addEventListener("input", notify);
    selLayout.addEventListener("change", notify);

    RadarFloorplanManager.attachEditorEvents(this, "mapFpEdit", this);
    RadarFloorplanManager.updateEditorForm(this, "mapFpEdit", this);
  }

  _updateDeviceOptions() {
    if (!this._hass) return;
    const sel = this.querySelector("#editorDeviceSelect");
    if (!sel) return;

    const devices = RadarEntityResolver.getDevices(this._hass);
    const curVal = (this._config && this._config.device) || "";

    sel.innerHTML = `
      <option value="">Select on drop-down</option>
      ${devices.map(d => `<option value="${d.prefix}" ${curVal === d.prefix ? "selected" : ""}>${d.name} (${d.prefix})</option>`).join("")}
    `;
    sel.value = curVal;

    RadarFloorplanManager.updateEditorForm(this, "mapFpEdit", this);
  }

  _updateFormValues() {
    if (!this._config) return;
    const inpTitle = this.querySelector("#editorTitleInput");
    if (inpTitle && document.activeElement !== inpTitle) {
      inpTitle.value = this._config.title || "Presence Radar Map";
    }
    const selDevice = this.querySelector("#editorDeviceSelect");
    if (selDevice && document.activeElement !== selDevice) {
      selDevice.value = this._config.device || "";
    }
    const selLayout = this.querySelector("#editorLayoutSelect");
    if (selLayout && document.activeElement !== selLayout) {
      selLayout.value = this._config.layout_mode || "full";
    }
    RadarFloorplanManager.updateEditorForm(this, "mapFpEdit", this);
  }
}

// ====================================================================
// UPDATE MANAGER: Firmware Version Parity & Update Notification Banner
// ====================================================================
class RadarUpdateManager {
  static REQUIRED_VERSION = "1.8.0";
  static _dismissed = new Set();

  static parseSemver(v) {
    if (!v || typeof v !== "string") return [0, 0, 0];
    const clean = v.replace(/^v/i, "").trim();
    const parts = clean.split(".").map(p => parseInt(p, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
  }

  static compareVersions(a, b) {
    const pa = this.parseSemver(a);
    const pb = this.parseSemver(b);
    for (let i = 0; i < 3; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }
    return 0;
  }

  static isDismissed(device) {
    return this._dismissed.has(device);
  }

  static dismiss(device) {
    if (device) this._dismissed.add(device);
  }

  static getEspHomePath(hass) {
    if (hass && hass.panels) {
      for (const [key, panel] of Object.entries(hass.panels)) {
        const pKey = (key || "").toLowerCase();
        const pTitle = ((panel && panel.title) || "").toLowerCase();
        const pUrl = (panel && panel.url_path) || key;
        const pComp = ((panel && panel.component_name) || "").toLowerCase();
        const addon = ((panel && panel.config && panel.config.addon) || "").toLowerCase();

        if (
          pKey.includes("esphome") ||
          pTitle.includes("esphome") ||
          pComp.includes("esphome") ||
          addon.includes("esphome")
        ) {
          return `/${pUrl}`;
        }
      }
    }
    // Default Supervisor ESPHome add-on panel slug
    return "/5c53de3b_esphome";
  }

  static navigateTo(element, path) {
    if (!path) return;

    // 1. Standard Home Assistant SPA router navigation event
    try {
      window.history.pushState(null, "", path);
      const event = new CustomEvent("location-changed", {
        bubbles: true,
        composed: true,
        detail: { replace: false }
      });
      if (element && element.dispatchEvent) {
        element.dispatchEvent(event);
      }
      window.dispatchEvent(event);
    } catch (err) {
      console.warn("HA location-changed event navigation failed:", err);
    }

    // 2. Fallback check: if pathname didn't change after 120ms (e.g. standalone iframe), assign window.location
    setTimeout(() => {
      if (!window.location.pathname.startsWith(path)) {
        window.location.assign(path);
      }
    }, 120);
  }

  static checkStatus(hass, entities, devicePrefix) {
    if (!hass || !entities) return { hasAlert: false };
    if (devicePrefix && this.isDismissed(devicePrefix)) return { hasAlert: false };

    const states = hass.states || {};

    // Only evaluate if sensor is alive/known in HA
    const occEnt = states[entities.occupancy];
    const t1Ent = states[entities.target1_x];
    const wifiEnt = states[entities.wifi_signal];
    const isAlive = (occEnt && occEnt.state !== "unavailable") ||
                    (t1Ent && t1Ent.state !== "unavailable") ||
                    (wifiEnt && wifiEnt.state !== "unavailable");

    if (!isAlive) return { hasAlert: false };

    // 1. Check for legacy architecture entity: number.active_zones
    const legacyActiveZonesId = entities.active_zones;
    const hasLegacyActiveZones = Boolean(legacyActiveZonesId && states[legacyActiveZonesId] && states[legacyActiveZonesId].state !== "unavailable");

    // 2. Check suite_version sensor
    const versionEntId = entities.suite_version;
    const versionState = versionEntId && states[versionEntId] ? states[versionEntId].state : null;
    const isMissingVersion = !versionState || versionState === "unknown" || versionState === "unavailable";

    const updateId = entities.firmware_update;
    const hasUpdateEntity = Boolean(updateId && states[updateId]);

    if (hasLegacyActiveZones || isMissingVersion) {
      return {
        hasAlert: true,
        isBreaking: true,
        type: "legacy",
        currentVersion: (!isMissingVersion && versionState) ? versionState : "pre-1.8.0",
        requiredVersion: this.REQUIRED_VERSION,
        updateEntity: hasUpdateEntity ? updateId : null,
        title: "ESPHome YAML Update Required",
        message: "This sensor is running older YAML. Update is required for dynamic per-zone toggles and radar engine parity."
      };
    }

    // 3. Version sensor exists, compare semantic version
    if (this.compareVersions(versionState, this.REQUIRED_VERSION) < 0) {
      return {
        hasAlert: true,
        isBreaking: true,
        type: "outdated",
        currentVersion: versionState,
        requiredVersion: this.REQUIRED_VERSION,
        updateEntity: hasUpdateEntity ? updateId : null,
        title: "Firmware Update Required",
        message: `Detected v${versionState}. Suite architecture requires v${this.REQUIRED_VERSION}+ for dynamic per-zone controls.`
      };
    }

    // 4. Parity is met, check if HA's ESPHome update entity is flagged "on"
    if (hasUpdateEntity && states[updateId].state === "on") {
      const attrs = states[updateId].attributes || {};
      return {
        hasAlert: true,
        isBreaking: false,
        type: "available",
        currentVersion: versionState,
        latestVersion: attrs.latest_version || "Latest",
        updateEntity: updateId,
        title: "Firmware Update Available",
        message: "A new ESPHome firmware build is ready for this sensor."
      };
    }

    return { hasAlert: false };
  }

  static renderBannerHtml(status, idPrefix, hass = null) {
    if (!status || !status.hasAlert) return "";
    const isBreaking = status.isBreaking;
    const espPath = this.getEspHomePath(hass);
    return `
      <div id="${idPrefix}UpdateBanner" class="radar-update-banner ${isBreaking ? 'breaking' : 'available'}">
        <div class="radar-update-banner-header">
          <div class="radar-update-banner-content">
            <div class="radar-update-icon">${isBreaking ? '⚠️' : '✨'}</div>
            <div style="flex: 1; min-width: 0;">
              <div class="radar-update-title">
                <span>${status.title}</span>
                <span class="radar-update-badge">${isBreaking ? `Detected: ${status.currentVersion} ➔ Required: v${status.requiredVersion}+` : `Update Available (${status.latestVersion})`}</span>
              </div>
              <div class="radar-update-sub">${status.message}</div>
            </div>
          </div>
          <button id="${idPrefix}BtnDismissBanner" class="radar-update-btn-close" title="Dismiss for this session">✕</button>
        </div>
        <div class="radar-update-actions">
          ${status.updateEntity ? `
            <button id="${idPrefix}BtnTriggerUpdate" class="btn-update-primary">
              🚀 Update Firmware in HA
            </button>
            <a id="${idPrefix}BtnOpenDashboard" href="${espPath}" class="btn-update-secondary" style="text-decoration:none; cursor:pointer;">
              🛠️ ESPHome Dashboard
            </a>
          ` : `
            <a id="${idPrefix}BtnOpenDashboard" href="${espPath}" class="btn-update-primary" style="text-decoration:none; cursor:pointer;">
              🚀 Open ESPHome Dashboard
            </a>
          `}
          <button id="${idPrefix}BtnViewGuide" class="btn-update-link">
            📋 YAML Setup Guide
          </button>
        </div>
      </div>
    `;
  }

  static attachEvents(shadowRoot, idPrefix, devicePrefix, cardInstance) {
    if (!shadowRoot) return;
    const btnDismiss = shadowRoot.getElementById(`${idPrefix}BtnDismissBanner`);
    if (btnDismiss) {
      btnDismiss.addEventListener("click", () => {
        const dev = (cardInstance && cardInstance._selectedDevice) || devicePrefix;
        this.dismiss(dev);
        const container = shadowRoot.getElementById(`${idPrefix}UpdateBannerContainer`);
        if (container) {
          container.innerHTML = "";
          container.dataset.statusKey = `${dev}_dismissed`;
        }
      });
    }

    const btnUpdate = shadowRoot.getElementById(`${idPrefix}BtnTriggerUpdate`);
    if (btnUpdate) {
      btnUpdate.addEventListener("click", () => {
        const status = this.checkStatus(radarStableHass(cardInstance._hass), cardInstance._entities, cardInstance._selectedDevice || devicePrefix);
        if (status && status.updateEntity && cardInstance._hass.states[status.updateEntity]) {
          cardInstance._openMoreInfo(status.updateEntity);
        }
      });
    }

    const btnDashboard = shadowRoot.getElementById(`${idPrefix}BtnOpenDashboard`);
    if (btnDashboard) {
      btnDashboard.addEventListener("click", (e) => {
        if (!e.ctrlKey && !e.metaKey && e.button === 0) {
          e.preventDefault();
          const espPath = this.getEspHomePath(cardInstance._hass);
          this.navigateTo(btnDashboard, espPath);
        }
      });
    }

    const btnGuide = shadowRoot.getElementById(`${idPrefix}BtnViewGuide`);
    if (btnGuide) {
      btnGuide.addEventListener("click", () => {
        const friendlyName = cardInstance._entities?.friendly_name ||
          (cardInstance._selectedDevice ? cardInstance._selectedDevice.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()) : "");
        RadarSetupWizard.open(shadowRoot, idPrefix === "calUpd" ? "calWz" : "mapWz", friendlyName);
      });
    }
  }

  static updateBanner(shadowRoot, idPrefix, hass, entities, devicePrefix, cardInstance) {
    if (!shadowRoot) return;
    const container = shadowRoot.getElementById(`${idPrefix}UpdateBannerContainer`);
    if (!container) return;

    const status = this.checkStatus(hass, entities, devicePrefix);
    const statusKey = status.hasAlert 
      ? `${devicePrefix}_${status.type}_${status.currentVersion}_${status.latestVersion || ""}`
      : `${devicePrefix}_none`;

    if (container.dataset.statusKey === statusKey) return;
    container.dataset.statusKey = statusKey;

    container.innerHTML = this.renderBannerHtml(status, idPrefix, hass);
    if (status.hasAlert) {
      this.attachEvents(shadowRoot, idPrefix, devicePrefix, cardInstance);
    }
  }
}

// ====================================================================
// SETUP WIZARD: In-Card Quick Setup Guide & YAML Generator
// ====================================================================
class RadarSetupWizard {
  static toKebab(str) {
    return (str || "presence-sensor")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  static generateYaml(friendlyName, board, txPin, rxPin) {
    const fName = (friendlyName || "Living Room Presence").trim();
    const nodeName = this.toKebab(fName);
    const b = (board || "esp32-c3-devkitm-1").trim();
    const tx = (txPin || "GPIO21").trim();
    const rx = (rxPin || "GPIO20").trim();

    return `# ====================================================================
# ESPHome Configuration for ${fName}
# 1-Minute Setup using Remote GitHub Package (Auto-updating)
# ====================================================================

substitutions:
  node_name: "${nodeName}"
  friendly_name: "${fName}"
  tx_pin: "${tx}"      # Connect to LD2450 RX
  rx_pin: "${rx}"      # Connect to LD2450 TX
  board: "${b}"

packages:
  radar_suite: github://bb12ett/esphome-radar-suite/esphome/ld2450_full.yaml@main
`;
  }

  static renderModalHtml(idPrefix = "wz", hass = null) {
    const espPath = RadarUpdateManager.getEspHomePath(hass);
    return `
      <div id="${idPrefix}ModalOverlay" class="radar-modal-overlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:9999; backdrop-filter:blur(4px); align-items:center; justify-content:center; padding:16px; box-sizing:border-box;">
        <div class="radar-modal-dialog" style="background:var(--card-bg, #0f172a); border:1px solid var(--border-color, rgba(255,255,255,0.15)); border-radius:16px; width:100%; max-width:540px; max-height:92vh; overflow-y:auto; padding:22px; box-shadow:0 20px 50px rgba(0,0,0,0.6); box-sizing:border-box; color:var(--text-color, #f8fafc); font-family:inherit; text-align:left; color-scheme:dark;">
          
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px;">
            <div>
              <div style="font-size:1.15rem; font-weight:700; display:flex; align-items:center; gap:8px;">
                <span>⚡</span> Add New Radar Sensor
              </div>
              <div style="font-size:0.8rem; color:var(--text-muted); margin-top:3px;">
                1-minute configuration using the remote GitHub package
              </div>
            </div>
            <button id="${idPrefix}BtnClose" style="background:transparent; border:none; color:var(--text-muted); font-size:1.25rem; cursor:pointer; padding:2px 6px; border-radius:4px;" title="Close">✕</button>
          </div>

          <div style="background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:12px; margin-bottom:16px; font-size:0.82rem; line-height:1.45;">
            <b>💡 How it works:</b> Paste this 10-line block into ESPHome. ESPHome automatically pulls the latest radar engine from GitHub and will keep it up-to-date whenever you re-flash.
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
            <div style="grid-column: 1 / -1;">
              <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-muted); margin-bottom:4px;">Room / Sensor Name</label>
              <input type="text" id="${idPrefix}InpName" class="form-input" value="Living Room Presence" placeholder="e.g. Living Room Presence" style="width:100%; box-sizing:border-box;" />
            </div>
            <div>
              <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-muted); margin-bottom:4px;">Board Model</label>
              <select id="${idPrefix}SelBoard" class="form-select" style="width:100%; box-sizing:border-box; color-scheme:dark; background:#1e293b; color:#f8fafc; border:1px solid rgba(255,255,255,0.15); border-radius:8px; padding:8px 12px; outline:none;">
                <option value="esp32-c3-devkitm-1" style="background:#1e293b; color:#f8fafc;" selected>ESP32-C3 SuperMini (Recommended)</option>
                <option value="esp32dev" style="background:#1e293b; color:#f8fafc;">Standard ESP32 (esp32dev)</option>
                <option value="d1_mini32" style="background:#1e293b; color:#f8fafc;">D1 Mini ESP32 (d1_mini32)</option>
              </select>
            </div>
            <div>
              <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--text-muted); margin-bottom:4px;">LD2450 UART Pins (TX / RX)</label>
              <div style="display:flex; gap:6px;">
                <input type="text" id="${idPrefix}InpTx" class="form-input" value="GPIO21" title="ESP32 TX (to LD2450 RX)" style="width:50%; box-sizing:border-box;" />
                <input type="text" id="${idPrefix}InpRx" class="form-input" value="GPIO20" title="ESP32 RX (to LD2450 TX)" style="width:50%; box-sizing:border-box;" />
              </div>
            </div>
          </div>

          <div style="position:relative; margin-bottom:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:0.75rem; font-weight:600; color:var(--text-muted);">Generated ESPHome YAML:</span>
              <button id="${idPrefix}BtnCopy" class="btn-secondary" style="padding:4px 10px; font-size:0.75rem; display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                📋 Copy YAML
              </button>
            </div>
            <textarea id="${idPrefix}TxtYaml" readonly style="width:100%; height:160px; box-sizing:border-box; background:rgba(0,0,0,0.35); border:1px solid var(--border-color); border-radius:8px; color:#38bdf8; font-family:monospace; font-size:0.8rem; padding:10px; resize:none; outline:none; white-space:pre;"></textarea>
          </div>

          <div style="font-size:0.82rem; margin-bottom:16px;">
            <div style="font-weight:700; margin-bottom:6px;">Quick 3-Step Setup:</div>
            <ol style="margin:0; padding-left:18px; color:var(--text-muted); display:flex; flex-direction:column; gap:4px;">
              <li>Open <b>ESPHome Dashboard</b> and click <b>New Device</b> &rarr; name it.</li>
              <li>Click <b>Edit</b>, replace the default configuration with the YAML above, and click <b>Save</b>.</li>
              <li>Click <b>Install</b> (via USB or Wirelessly). Once online, Home Assistant will adopt it and it will appear here automatically!</li>
            </ol>
          </div>

          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <a id="${idPrefix}BtnOpenDashboard" href="${espPath}" class="btn-primary" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px; padding:9px 16px; font-size:0.85rem; cursor:pointer;">
              🚀 Open ESPHome Dashboard
            </a>
            <button id="${idPrefix}BtnDone" class="btn-secondary" style="padding:9px 16px; font-size:0.85rem; cursor:pointer;">
              Close
            </button>
          </div>

        </div>
      </div>
    `;
  }

  static attachEvents(shadowRoot, idPrefix, onToast, cardInstance = null) {
    const overlay = shadowRoot.getElementById(`${idPrefix}ModalOverlay`);
    if (!overlay) return;

    const inpName = shadowRoot.getElementById(`${idPrefix}InpName`);
    const selBoard = shadowRoot.getElementById(`${idPrefix}SelBoard`);
    const inpTx = shadowRoot.getElementById(`${idPrefix}InpTx`);
    const inpRx = shadowRoot.getElementById(`${idPrefix}InpRx`);
    const txtYaml = shadowRoot.getElementById(`${idPrefix}TxtYaml`);
    const btnCopy = shadowRoot.getElementById(`${idPrefix}BtnCopy`);
    const btnClose = shadowRoot.getElementById(`${idPrefix}BtnClose`);
    const btnDone = shadowRoot.getElementById(`${idPrefix}BtnDone`);

    const updateYaml = () => {
      if (txtYaml) {
        txtYaml.value = this.generateYaml(
          inpName ? inpName.value : "Living Room Presence",
          selBoard ? selBoard.value : "esp32-c3-devkitm-1",
          inpTx ? inpTx.value : "GPIO21",
          inpRx ? inpRx.value : "GPIO20"
        );
      }
    };

    updateYaml();

    if (inpName) inpName.addEventListener("input", updateYaml);
    if (selBoard) selBoard.addEventListener("change", updateYaml);
    if (inpTx) inpTx.addEventListener("input", updateYaml);
    if (inpRx) inpRx.addEventListener("input", updateYaml);

    if (btnCopy) {
      btnCopy.addEventListener("click", () => {
        if (txtYaml) {
          navigator.clipboard.writeText(txtYaml.value).then(() => {
            if (onToast) onToast("YAML copied to clipboard!");
            btnCopy.textContent = "✅ Copied!";
            setTimeout(() => { btnCopy.textContent = "📋 Copy YAML"; }, 2000);
          }).catch(() => {
            txtYaml.select();
            document.execCommand("copy");
            if (onToast) onToast("YAML copied to clipboard!");
          });
        }
      });
    }

    const hide = () => {
      overlay.style.display = "none";
    };

    if (btnClose) btnClose.addEventListener("click", hide);
    if (btnDone) btnDone.addEventListener("click", hide);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hide();
    });

    const btnOpenDash = shadowRoot.getElementById(`${idPrefix}BtnOpenDashboard`);
    if (btnOpenDash) {
      btnOpenDash.addEventListener("click", (e) => {
        if (!e.ctrlKey && !e.metaKey && e.button === 0) {
          e.preventDefault();
          const espPath = RadarUpdateManager.getEspHomePath(cardInstance?._hass || window.hass);
          hide();
          RadarUpdateManager.navigateTo(btnOpenDash, espPath);
        }
      });
    }
  }

  static open(shadowRoot, idPrefix, friendlyName = "") {
    const overlay = shadowRoot.getElementById(`${idPrefix}ModalOverlay`);
    if (overlay) {
      overlay.style.display = "flex";
      const inp = shadowRoot.getElementById(`${idPrefix}InpName`);
      if (inp) {
        if (friendlyName) {
          inp.value = friendlyName;
          inp.dispatchEvent(new Event("input"));
        }
        setTimeout(() => inp.focus(), 50);
      }
    }
  }
}

// ====================================================================
// CARD 1: RADAR MAP CARD (<radar-map-card>)
// ====================================================================
class RadarMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._trails = { 1: [], 2: [], 3: [] };
    this._selectedDevice = "";
    this._syncHandler = null;
  }

  static getConfigElement() {
    return document.createElement("radar-map-card-editor");
  }

  static getStubConfig() {
    return {
      title: "Presence Radar Map",
      device: "",
      layout_mode: "full"
    };
  }

  setConfig(config) {
    this._config = Object.assign({
      title: "Presence Radar Map",
      device: "",
      layout_mode: "full"
    }, config);

    if (this._config.device) {
      this._selectedDevice = this._config.device;
    }

    if (this._rendered && this._hass) {
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
      this._trails = { 1: [], 2: [], 3: [] };
      this._watchIds = null;
      this._lastSig = null;
      this._render();
      this._update();
    }
  }

  connectedCallback() {
    this._syncHandler = (e) => {
      // Only follow external sync if this card is set to "Select on drop-down" (not pinned)
      if (!this._config.device && e.detail && e.detail.device && e.detail.device !== this._selectedDevice) {
        this._switchDevice(e.detail.device, false);
      }
    };
    window.addEventListener("radar-device-selected", this._syncHandler);

    // Re-resolve entity IDs once the HA entity registry arrives / changes
    this._unsubRegistry = RadarEntityResolver.onRegistryChange(() => {
      if (!this._hass || !this._rendered || this._emptyState) return;
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
      this._watchIds = null;
      this._lastSig = null;
      this._update();
    });
  }

  disconnectedCallback() {
    if (this._syncHandler) {
      window.removeEventListener("radar-device-selected", this._syncHandler);
      this._syncHandler = null;
    }
    if (this._unsubRegistry) {
      this._unsubRegistry();
      this._unsubRegistry = null;
    }
  }

  _switchDevice(device, broadcast) {
    this._selectedDevice = device;
    this._trails = { 1: [], 2: [], 3: [] };
    this._watchIds = null;
    this._lastSig = null;
    if (!this._hass) return;
    this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
    const sel = this.shadowRoot.getElementById("mapDeviceSelect");
    if (sel && sel.value !== device) sel.value = device;
    if (broadcast) {
      window.dispatchEvent(new CustomEvent("radar-device-selected", { detail: { device } }));
    }
    this._update();
  }

  // Signature of this device's entity states - lets us ignore the (very frequent)
  // hass updates caused by unrelated entities elsewhere in Home Assistant.
  _computeSig() {
    const ent = this._entities || {};
    if (!this._watchIds) {
      this._watchIds = Object.values(ent).filter(v => typeof v === "string" && v.indexOf(".") > 0);
    }
    const states = this._hass.states;
    let sig = RadarEntityResolver._registryVersion + "|";
    for (const id of this._watchIds) {
      const s = states[id];
      sig += (s ? s.state : "-") + "|";
    }
    return sig;
  }

  set hass(hass) {
    this._hass = hass;
    RadarEntityResolver.loadEntityRegistry(hass);

    if (!this._selectedDevice) {
      if (this._config && this._config.device) {
        this._selectedDevice = this._config.device;
      } else {
        const devs = RadarEntityResolver.getDevices(hass);
        if (devs.length > 0) {
          this._selectedDevice = devs[0].prefix;
        }
      }
    }

    if (!this._rendered) {
      this._entities = RadarEntityResolver.resolve(hass, { device: this._selectedDevice });
      this._render();
      this._rendered = true;
      this._lastSig = null;
    } else if (this._emptyState || (this._entities && !hass.states[this._entities.target1_x])) {
      // Throttled re-discovery so the card enters / leaves the empty state without a page reload
      const now = Date.now();
      if (!this._lastDevCheck || now - this._lastDevCheck > 3000) {
        this._lastDevCheck = now;
        const devs = RadarEntityResolver.getDevices(hass);
        if ((devs.length > 0) === Boolean(this._emptyState)) {
          if (devs.length > 0 && !devs.some(d => d.prefix === this._selectedDevice)) {
            this._selectedDevice = (this._config && this._config.device) || devs[0].prefix;
          }
          this._entities = RadarEntityResolver.resolve(hass, { device: this._selectedDevice });
          this._watchIds = null;
          this._lastSig = null;
          this._render();
        }
      }
    }

    if (this._emptyState) return;
    const sig = this._computeSig();
    if (sig === this._lastSig) return;
    this._lastSig = sig;
    this._update();
  }

  _render() {
    const devices = RadarEntityResolver.getDevices(this._hass);
    this._emptyState = devices.length === 0;

    if (devices.length === 0) {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            font-family: var(--ha-font-family, 'Segoe UI', Roboto, sans-serif);
            color-scheme: dark;
            --card-bg: var(--ha-card-background, var(--card-background-color, #0f172a));
            --primary-color: #38bdf8;
            --text-color: var(--primary-text-color, #f8fafc);
            --text-muted: var(--secondary-text-color, #94a3b8);
            --border-color: rgba(255, 255, 255, 0.1);
          }
          ha-card {
            background: var(--card-bg);
            border-radius: 16px;
            border: 1px solid var(--border-color);
            padding: 36px 20px;
            color: var(--text-color);
            text-align: center;
          }
          .btn-primary {
            background: var(--primary-color);
            color: #0f172a;
            border: none;
            padding: 10px 22px;
            border-radius: 8px;
            font-size: 0.9rem;
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
          }
          .btn-secondary {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-color);
            color: var(--text-color);
            border-radius: 8px;
          }
        </style>
        <ha-card>
          <div style="font-size: 3rem; margin-bottom: 12px;">📡</div>
          <div style="font-size: 1.25rem; font-weight: 700; margin-bottom: 6px;">No Presence Sensors Found</div>
          <div style="font-size: 0.85rem; color: var(--text-muted); max-width: 420px; margin: 0 auto 20px; line-height: 1.5;">
            No HLK-LD2450 radar sensors were detected in Home Assistant yet. Use our 1-minute setup wizard to configure and add your first sensor.
          </div>
          <button class="btn-primary" id="btnMapEmptySetup">
            ⚡ Quick Setup Guide & YAML Generator
          </button>
          ${RadarSetupWizard.renderModalHtml("mapWz", this._hass)}
        </ha-card>
      `;
      RadarSetupWizard.attachEvents(this.shadowRoot, "mapWz", null, this);
      const btn = this.shadowRoot.getElementById("btnMapEmptySetup");
      if (btn) btn.addEventListener("click", () => RadarSetupWizard.open(this.shadowRoot, "mapWz"));
      return;
    }

    const hasPinnedDevice = Boolean(this._config && this._config.device);
    const isMinimal = this._config && this._config.layout_mode === "minimal";
    const updateStatus = RadarUpdateManager.checkStatus(this._hass, this._entities, this._selectedDevice);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--ha-font-family, 'Segoe UI', Roboto, sans-serif);
          color-scheme: dark;
          --card-bg: var(--ha-card-background, var(--card-background-color, #0f172a));
          --primary-color: #38bdf8;
          --accent-color: #0284c7;
          --occupied-color: #10b981;
          --text-color: var(--primary-text-color, #f8fafc);
          --text-muted: var(--secondary-text-color, #94a3b8);
          --border-color: rgba(255, 255, 255, 0.1);
        }
        ha-card {
          background: var(--card-bg);
          border-radius: 16px;
          border: 1px solid var(--border-color);
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
          overflow: hidden;
          padding: 16px;
          color: var(--text-color);
          container-type: inline-size;
        }
        .header {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 14px;
        }
        .header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }
        .title-wrapper {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 0 auto;
        }
        .card-icon {
          width: 24px;
          height: 24px;
          fill: var(--primary-color);
          flex-shrink: 0;
        }
        .card-title {
          font-size: 1.15rem;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .device-selector-wrapper {
          flex: 0 1 260px;
          width: 100%;
          max-width: 260px;
          height: auto;
        }
        .device-select {
          width: 100%;
          padding: 6px 10px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.07);
          color: var(--text-color, #f8fafc);
          border: 1px solid var(--border-color);
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
          outline: none;
          box-sizing: border-box;
          height: 36px;
          color-scheme: dark;
        }
        .device-select:focus {
          border-color: var(--primary-color);
        }
        .device-select option {
          background-color: #1e293b;
          color: #f8fafc;
        }
        .device-select option[value="__new__"] {
          background-color: #1e293b;
          color: #38bdf8;
          font-weight: 700;
        }
        @container (max-width: 480px) {
          .title-wrapper {
            flex: 0 0 100%;
            width: 100%;
          }
          .device-selector-wrapper {
            flex: 0 0 auto;
            max-width: 100%;
            width: 100%;
          }
        }
        @media (max-width: 480px) {
          .title-wrapper {
            flex: 0 0 100%;
            width: 100%;
          }
          .device-selector-wrapper {
            flex: 0 0 auto;
            max-width: 100%;
            width: 100%;
          }
        }
        .chips-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 20px;
          font-size: 0.75rem;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--border-color);
          cursor: pointer;
          user-select: none;
          transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .chip:hover {
          transform: translateY(-1px);
          border-color: var(--primary-color);
          background: rgba(255, 255, 255, 0.12);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        }
        .chip:active {
          transform: translateY(0);
        }
        .chip.occupied {
          background: rgba(16, 185, 129, 0.15);
          border-color: rgba(16, 185, 129, 0.4);
          color: #34d399;
        }
        .chip.occupied:hover {
          background: rgba(16, 185, 129, 0.25);
          border-color: #34d399;
        }
        .chip.latched {
          background: rgba(168, 85, 247, 0.15);
          border-color: rgba(168, 85, 247, 0.4);
          color: #c084fc;
        }
        .chip.latched:hover {
          background: rgba(168, 85, 247, 0.25);
          border-color: #c084fc;
        }
        .map-viewport {
          position: relative;
          width: 100%;
          aspect-ratio: 4 / 3;
          background: radial-gradient(circle at 50% 10%, #1e293b 0%, #0f172a 80%);
          border-radius: 12px;
          border: 1px solid var(--border-color);
          overflow: hidden;
        }
        svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .details-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 8px;
          margin-top: 14px;
        }
        .detail-card {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 8px 10px;
          cursor: pointer;
          user-select: none;
          transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .detail-card:hover {
          transform: translateY(-1px);
          border-color: var(--primary-color);
          background: rgba(255, 255, 255, 0.08);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        }
        .detail-card:active {
          transform: translateY(0);
        }
        .detail-title {
          font-size: 0.7rem;
          color: var(--text-muted);
          text-transform: uppercase;
          font-weight: 700;
        }
        .detail-val {
          font-size: 0.95rem;
          font-weight: 700;
          margin-top: 2px;
          color: var(--text-color);
        }
        .zones-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
          gap: 6px;
          margin-top: 10px;
        }
        .zone-pill {
          padding: 6px 8px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-color);
          text-align: center;
          font-size: 0.72rem;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
          transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
        }
        .zone-pill:hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
          filter: brightness(1.2);
        }
        .zone-pill:active {
          transform: translateY(0);
        }
        .zone-pill.active {
          background: rgba(56, 189, 248, 0.15);
          border-color: rgba(56, 189, 248, 0.4);
          color: #38bdf8;
        }
        .zone-pill.occupied {
          background: rgba(16, 185, 129, 0.2);
          border-color: rgba(16, 185, 129, 0.6);
          color: #34d399;
          font-weight: 700;
        }
        .zone-pill.exclusion {
          border-color: rgba(239, 68, 68, 0.4);
          color: #f87171;
        }
        .zone-pill.exclusion.active {
          background: rgba(239, 68, 68, 0.12);
          border-color: rgba(239, 68, 68, 0.5);
          color: #fca5a5;
        }
        .zone-pill.exclusion.occupied {
          background: rgba(239, 68, 68, 0.25);
          border-color: #ef4444;
          color: #fecaca;
          font-weight: 700;
        }
        .zone-polygon-group {
          cursor: pointer;
        }
        .zone-polygon-group polygon {
          pointer-events: all;
          transition: stroke-width 0.2s ease, filter 0.2s ease;
        }
        .zone-polygon-group text {
          pointer-events: none;
        }
        .zone-polygon-group:hover polygon {
          stroke-width: 22px;
          filter: drop-shadow(0 0 14px rgba(56, 189, 248, 0.8));
        }
        .zone-polygon-group.exclusion:hover polygon {
          stroke-width: 22px;
          filter: drop-shadow(0 0 14px rgba(239, 68, 68, 0.8));
        }
        /* Firmware & YAML Update Alert Banner */
        .radar-update-container {
          width: 100%;
        }
        .radar-update-banner {
          background: rgba(245, 158, 11, 0.12);
          border: 1px solid rgba(245, 158, 11, 0.45);
          border-radius: 12px;
          padding: 12px 14px;
          margin-bottom: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: radarFadeIn 0.3s ease-in-out;
          box-sizing: border-box;
        }
        .radar-update-banner.available {
          background: rgba(56, 189, 248, 0.12);
          border-color: rgba(56, 189, 248, 0.45);
        }
        .radar-update-banner-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
        }
        .radar-update-banner-content {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          flex: 1;
          min-width: 0;
        }
        .radar-update-icon {
          font-size: 1.25rem;
          line-height: 1;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .radar-update-title {
          font-size: 0.86rem;
          font-weight: 700;
          color: #fbbf24;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .radar-update-banner.available .radar-update-title {
          color: #38bdf8;
        }
        .radar-update-badge {
          font-size: 0.7rem;
          font-weight: 600;
          background: rgba(245, 158, 11, 0.22);
          border: 1px solid rgba(245, 158, 11, 0.4);
          color: #fbbf24;
          padding: 1px 6px;
          border-radius: 4px;
        }
        .radar-update-banner.available .radar-update-badge {
          background: rgba(56, 189, 248, 0.2);
          border-color: rgba(56, 189, 248, 0.4);
          color: #38bdf8;
        }
        .radar-update-sub {
          font-size: 0.78rem;
          color: var(--text-color, #f8fafc);
          opacity: 0.88;
          line-height: 1.4;
          margin-top: 3px;
        }
        .radar-update-btn-close {
          background: transparent;
          border: none;
          color: var(--text-muted, #94a3b8);
          font-size: 1.1rem;
          cursor: pointer;
          padding: 0 4px;
          line-height: 1;
          opacity: 0.7;
          border-radius: 4px;
        }
        .radar-update-btn-close:hover {
          opacity: 1;
          color: var(--text-color, #f8fafc);
        }
        .radar-update-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding-left: 30px;
        }
        .btn-update-primary {
          background: #f59e0b;
          color: #0f172a;
          border: none;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: background 0.15s, box-shadow 0.15s;
        }
        .btn-update-primary:hover {
          background: #fbbf24;
          box-shadow: 0 2px 8px rgba(245, 158, 11, 0.4);
        }
        .radar-update-banner.available .btn-update-primary {
          background: #38bdf8;
        }
        .radar-update-banner.available .btn-update-primary:hover {
          background: #7dd3fc;
          box-shadow: 0 2px 8px rgba(56, 189, 248, 0.4);
        }
        .btn-update-secondary {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-color, #f8fafc);
          border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: background 0.15s;
        }
        .btn-update-secondary:hover {
          background: rgba(255, 255, 255, 0.14);
        }
        .btn-update-link {
          background: transparent;
          border: none;
          color: var(--primary-color, #38bdf8);
          font-size: 0.76rem;
          font-weight: 600;
          cursor: pointer;
          padding: 4px 6px;
          text-decoration: underline;
        }
        @keyframes radarFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      </style>

      <ha-card>
        <div class="header">
          <div class="header-top">
            <div class="title-wrapper">
              <svg class="card-icon" viewBox="0 0 24 24">
                <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/>
              </svg>
              <div class="card-title">${this._config.title || "Presence Radar Map"}</div>
            </div>
            <div class="device-selector-wrapper" style="${hasPinnedDevice ? "display: none;" : ""}">
              <select id="mapDeviceSelect" class="device-select">
                ${devices.map(d => `<option value="${d.prefix}" ${this._selectedDevice === d.prefix ? "selected" : ""}>${d.name}</option>`).join("")}
                <option value="__new__" style="color:var(--primary-color); font-weight:700;">➕ Add New Sensor...</option>
              </select>
            </div>
          </div>

          <div class="chips-bar" id="chipsBar">
            <div class="chip" id="chipOccupancy">⚪ Clear</div>
            <div class="chip" id="chipTargets">🎯 0 Targets</div>
            <div class="chip" id="chipLatched" style="display:none;">🧠 Latched</div>
            <div class="chip" id="chipWifi">📶 -- dBm</div>
          </div>
        </div>

        <div id="mapUpdUpdateBannerContainer" class="radar-update-container">
          ${RadarUpdateManager.renderBannerHtml(updateStatus, "mapUpd", this._hass)}
        </div>

        <div class="map-viewport">
          <svg id="radarSvg" viewBox="-3000 -500 6000 6500" preserveAspectRatio="xMidYMid meet">
            <defs>
              <radialGradient id="beamGradient" cx="50%" cy="0%" r="100%">
                <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3" />
                <stop offset="60%" stop-color="#0284c7" stop-opacity="0.08" />
                <stop offset="100%" stop-color="#0284c7" stop-opacity="0" />
              </radialGradient>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="30" result="blur" />
                <feMerge>
                  <feMergeNode in="blur"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
              <clipPath id="radarRoomClip">
                <rect id="radarRoomClipRect" x="0" y="0" width="4000" height="5000" rx="6" />
              </clipPath>
              <pattern id="exclusionHatch" width="80" height="80" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="80" stroke="#ef4444" stroke-width="20" stroke-opacity="0.35" />
              </pattern>
            </defs>

            <!-- Floorplan Background Layer -->
            <g id="mapFloorplanLayer"></g>

            <!-- Room Boundaries & Walls -->
            <g id="roomLayer"></g>

            <!-- Detection Zones -->
            <g id="zonesLayer"></g>

            <!-- Exclusion Masks -->
            <g id="masksLayer"></g>

            <!-- Radar Beam Cone -->
            <path id="beamCone" fill="url(#beamGradient)" opacity="0.8" />

            <!-- Motion Trails -->
            <g id="trailsLayer"></g>

            <!-- Active Targets -->
            <g id="targetsLayer"></g>

            <!-- Sensor Mount Icon -->
            <g id="sensorIconLayer"></g>
          </svg>
        </div>

        <div class="details-grid" id="targetsDetailsGrid" style="${isMinimal ? "display: none;" : ""}">
          <div class="detail-card"><div class="detail-title">Target 1</div><div class="detail-val" id="valT1">Inactive</div></div>
          <div class="detail-card"><div class="detail-title">Target 2</div><div class="detail-val" id="valT2">Inactive</div></div>
          <div class="detail-card"><div class="detail-title">Target 3</div><div class="detail-val" id="valT3">Inactive</div></div>
        </div>

        <div class="zones-row" id="zonesRow" style="${isMinimal ? "display: none;" : ""}">
          <div class="zone-pill" id="pillZ1">Zone 1</div>
          <div class="zone-pill" id="pillZ2">Zone 2</div>
          <div class="zone-pill" id="pillZ3">Zone 3</div>
          <div class="zone-pill" id="pillZ4">Zone 4</div>
        </div>
        ${RadarSetupWizard.renderModalHtml("mapWz", this._hass)}
      </ha-card>
    `;

    RadarSetupWizard.attachEvents(this.shadowRoot, "mapWz", null, this);
    RadarUpdateManager.attachEvents(this.shadowRoot, "mapUpd", this._selectedDevice, this);

    const selectEl = this.shadowRoot.getElementById("mapDeviceSelect");
    if (selectEl) {
      selectEl.addEventListener("change", (e) => {
        if (e.target.value === "__new__") {
          e.target.value = this._selectedDevice;
          RadarSetupWizard.open(this.shadowRoot, "mapWz");
          return;
        }
        this._switchDevice(e.target.value, true);
      });
    }

    const chipsBar = this.shadowRoot.getElementById("chipsBar");
    if (chipsBar) {
      chipsBar.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        const entityId = chip.dataset?.entity || chip.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }

    const zonesRow = this.shadowRoot.getElementById("zonesRow");
    if (zonesRow) {
      zonesRow.addEventListener("click", (e) => {
        const pill = e.target.closest(".zone-pill");
        if (!pill) return;
        const entityId = pill.dataset?.entity || pill.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }

    const zonesLayer = this.shadowRoot.getElementById("zonesLayer");
    if (zonesLayer) {
      zonesLayer.addEventListener("click", (e) => {
        const grp = e.target.closest(".zone-polygon-group");
        if (!grp) return;
        const entityId = grp.dataset?.entity || grp.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }

    const detailsGrid = this.shadowRoot.getElementById("targetsDetailsGrid");
    if (detailsGrid) {
      detailsGrid.addEventListener("click", (e) => {
        const card = e.target.closest(".detail-card");
        if (!card) return;
        const entityId = card.dataset?.entity || card.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }
  }

  _openMoreInfo(entityId) {
    if (!entityId) return;
    const event = new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: { entityId }
    });
    this.dispatchEvent(event);
    window.dispatchEvent(event);
  }

  _update() {
    if (!this._hass || !this.shadowRoot) return;
    if (!this._entities) {
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
    }
    const stableHass = radarStableHass(this._hass);
    RadarUpdateManager.updateBanner(this.shadowRoot, "mapUpd", stableHass, this._entities, this._selectedDevice, this);

    const ent = this._entities;
    const states = this._hass.states;   // live values (targets, chips)
    const sStates = stableHass.states;  // last-known-good values (zones, room geometry)

    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return isNaN(v) ? def : v;
    };
    const getState = (id, def = "off") => (id && states[id]) ? states[id].state : def;
    const getValS = (id, def = 0) => {
      if (!id || !sStates[id]) return def;
      const v = parseFloat(sStates[id].state);
      return isNaN(v) ? def : v;
    };
    const getStateS = (id, def = "off") => (id && sStates[id]) ? sStates[id].state : def;
    const t1State = states[ent.target1_x];
    const isOffline = !t1State || t1State.state === "unavailable";

    // Header Chips
    const occ = getState(ent.occupancy, "off") === "on";
    const chipOcc = this.shadowRoot.getElementById("chipOccupancy");
    if (chipOcc) {
      chipOcc.className = "chip " + (occ ? "occupied" : "");
      chipOcc.textContent = occ ? "🟢 Occupied" : "⚪ Clear";
      chipOcc.dataset.entity = ent.occupancy || "";
      chipOcc.title = ent.occupancy ? `Click to view history (${ent.occupancy})` : "Occupancy";
    }

    const tc = getVal(ent.target_count, 0);
    const chipTc = this.shadowRoot.getElementById("chipTargets");
    if (chipTc) {
      chipTc.textContent = `🎯 ${tc} Target${tc === 1 ? "" : "s"}`;
      chipTc.dataset.entity = ent.target_count || "";
      chipTc.title = ent.target_count ? `Click to view history (${ent.target_count})` : "Target Count";
    }

    const latched = getState(ent.stationary_memory_active, "off") === "on";
    const chipLatch = this.shadowRoot.getElementById("chipLatched");
    if (chipLatch) {
      chipLatch.style.display = latched ? "inline-flex" : "none";
      chipLatch.className = "chip latched";
      chipLatch.dataset.entity = ent.stationary_memory_active || "";
      chipLatch.title = ent.stationary_memory_active ? `Click to view history (${ent.stationary_memory_active})` : "Stationary Latch";
    }

    const wifi = states[ent.wifi_signal] ? states[ent.wifi_signal].state : "--";
    const chipWifi = this.shadowRoot.getElementById("chipWifi");
    if (chipWifi) {
      chipWifi.textContent = isOffline ? "⏳ Reconnecting…" : `📶 ${wifi} dBm`;
      chipWifi.dataset.entity = ent.wifi_signal || "";
      chipWifi.title = ent.wifi_signal ? `Click to view history (${ent.wifi_signal})` : "Wi-Fi Signal";
    }

    // Geometry Calculation directly from ESP32 Sensor
    const geom = RoomGeometry.compute(this._config, ent, stableHass);

    // Update SVG ViewBox and Room Clip based on room dimensions (expands if sensor offset exceeds room wall)
    const svg = this.shadowRoot.getElementById("radarSvg");
    if (svg) {
      const margin = 500;
      const minVbX = Math.min(0, geom.sx) - margin;
      const maxVbX = Math.max(geom.roomWidth, geom.sx) + margin;
      svg.setAttribute("viewBox", `${minVbX} ${-margin} ${maxVbX - minVbX} ${geom.roomDepth + margin * 2}`);
      const clipRect = this.shadowRoot.getElementById("radarRoomClipRect");
      if (clipRect) {
        clipRect.setAttribute("width", geom.roomWidth);
        clipRect.setAttribute("height", geom.roomDepth);
      }
    }

    // Render Floorplan Layer
    const fp = RadarFloorplanManager.getFloorplan(this._config, this._selectedDevice);
    const mapFpLayer = this.shadowRoot.getElementById("mapFloorplanLayer");
    if (mapFpLayer) {
      radarSetHtml(mapFpLayer, RadarFloorplanManager.renderFloorplanSvg(fp, geom, "radarRoomClip"));
    }

    // Render Room Walls
    const roomLayer = this.shadowRoot.getElementById("roomLayer");
    if (roomLayer) {
      const hasFp = Boolean(fp && fp.image);
      const roomFill = hasFp ? "none" : "rgba(15, 23, 42, 0.6)";
      radarSetHtml(roomLayer, `
        <!-- Outer Architectural Wall -->
        <rect x="0" y="0" width="${geom.roomWidth}" height="${geom.roomDepth}"
              fill="${roomFill}" stroke="#38bdf8" stroke-width="8" rx="6" />
        <!-- Dimension Labels -->
        <text x="${geom.roomWidth / 2}" y="-120" fill="#94a3b8" font-size="160" font-weight="700" text-anchor="middle">
          ${Math.round(geom.roomWidth)} mm
        </text>
        <text x="-120" y="${geom.roomDepth / 2}" fill="#94a3b8" font-size="160" font-weight="700" text-anchor="middle"
              transform="rotate(-90, -120, ${geom.roomDepth / 2})">
          ${Math.round(geom.roomDepth)} mm
        </text>
      `);
    }

    // Render Sensor Icon & Angled Beam Cone
    const sensorIconLayer = this.shadowRoot.getElementById("sensorIconLayer");
    const beamCone = this.shadowRoot.getElementById("beamCone");
    if (sensorIconLayer && beamCone) {
      const sx = geom.sx;
      const sy = 0;
      radarSetHtml(sensorIconLayer, `
        <circle cx="${sx}" cy="${sy}" r="120" fill="#0284c7" stroke="#38bdf8" stroke-width="12" />
        <circle cx="${sx}" cy="${sy}" r="40" fill="#fff" />
      `);

      const beamDist = Math.max(geom.roomWidth, geom.roomDepth) * 1.3;
      const radCenter = (((geom.angle || 0) + 90) * Math.PI) / 180;
      const fovRad = (60 * Math.PI) / 180;
      const leftAngle = radCenter - fovRad;
      const rightAngle = radCenter + fovRad;

      const lx = sx + beamDist * Math.cos(leftAngle);
      const ly = sy + beamDist * Math.sin(leftAngle);
      const rx = sx + beamDist * Math.cos(rightAngle);
      const ry = sy + beamDist * Math.sin(rightAngle);

      beamCone.setAttribute("d", `M ${sx} ${sy} L ${lx} ${ly} A ${beamDist} ${beamDist} 0 0 1 ${rx} ${ry} Z`);
    }

    // Render Zones & Exclusion Masks
    const activeZonesList = RadarEntityResolver.getActiveZones(stableHass, ent);
    const zonesRow = this.shadowRoot.getElementById("zonesRow");
    if (zonesRow) {
      if (activeZonesList.length === 0) {
        radarSetHtml(zonesRow, "");
        zonesRow.style.display = "none";
      } else {
        const isMinimal = this._config && this._config.layout_mode === "minimal";
        zonesRow.style.display = isMinimal ? "none" : "grid";
        let pillsHtml = "";
        for (const z of activeZonesList) {
          const x1 = getValS(ent[`zone${z}_x1`]);
          const y1 = getValS(ent[`zone${z}_y1`]);
          const x2 = getValS(ent[`zone${z}_x2`]);
          const y2 = getValS(ent[`zone${z}_y2`]);
          const isConfigured = !(x1 === 0 && x2 === 0 && y1 === 0 && y2 === 0);
          const zOcc = getStateS(ent[`zone${z}_occupancy`]) === "on";
          const isExcl = getStateS(ent[`zone${z}_mode`]) === "Exclusion";
          const zEntity = ent[`zone${z}_occupancy`] || "";

          const cls = "zone-pill" +
                      (isExcl ? " exclusion" : "") +
                      (isConfigured ? (zOcc ? " occupied" : " active") : "");
          const label = `Z${z}${isExcl ? " (Mask)" : ""}${zOcc ? (isExcl ? " ⚠️" : " (OCC)") : ""}`;
          pillsHtml += `<div class="${cls}" id="pillZ${z}" data-entity="${zEntity}" title="${zEntity ? `Click to view Zone ${z} history (${zEntity})` : `Zone ${z}`}">${label}</div>`;
        }
        radarSetHtml(zonesRow, pillsHtml);
      }
    }

    const zonesLayer = this.shadowRoot.getElementById("zonesLayer");
    if (zonesLayer) {
      let zonesHtml = "";
      for (const z of activeZonesList) {
        const x1 = getValS(ent[`zone${z}_x1`]);
        const y1 = getValS(ent[`zone${z}_y1`]);
        const x2 = getValS(ent[`zone${z}_x2`]);
        const y2 = getValS(ent[`zone${z}_y2`]);
        const zAngle = getValS(ent[`zone${z}_angle`], 0);
        const zOcc = getStateS(ent[`zone${z}_occupancy`]) === "on";
        const isExcl = getStateS(ent[`zone${z}_mode`]) === "Exclusion";
        const zEntity = ent[`zone${z}_occupancy`] || "";

        if (x1 !== 0 || x2 !== 0 || y1 !== 0 || y2 !== 0) {
          const corners = RoomGeometry.transformZonePolygon(x1, y1, x2, y2, zAngle, geom);
          const pts = corners.map(p => `${p.x},${p.y}`).join(" ");

          if (isExcl) {
            const stroke = zOcc ? "#ef4444" : "#f87171";
            const fill = zOcc ? "rgba(239, 68, 68, 0.35)" : "url(#exclusionHatch)";
            zonesHtml += `
              <g class="zone-polygon-group exclusion" data-zone="${z}" data-entity="${zEntity}">
                <title>${zEntity ? `Zone ${z} (Mask) - Click to view history (${zEntity})` : `Zone ${z} (Mask)`}</title>
                <polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="12" stroke-dasharray="25,15" />
                <text x="${(corners[0].x + corners[2].x) / 2}" y="${(corners[0].y + corners[2].y) / 2}" fill="${stroke}"
                      font-size="140" font-weight="700" text-anchor="middle" dominant-baseline="middle">
                  Zone ${z} (Mask)${zOcc ? " ⚠️" : ""}
                </text>
              </g>
            `;
          } else {
            const stroke = zOcc ? "#10b981" : "#38bdf8";
            const fill = zOcc ? "rgba(16, 185, 129, 0.25)" : "rgba(56, 189, 248, 0.1)";
            zonesHtml += `
              <g class="zone-polygon-group" data-zone="${z}" data-entity="${zEntity}">
                <title>${zEntity ? `Zone ${z} - Click to view history (${zEntity})` : `Zone ${z}`}</title>
                <polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="12" stroke-dasharray="${zOcc ? "none" : "30,15"}" />
                <text x="${(corners[0].x + corners[2].x) / 2}" y="${(corners[0].y + corners[2].y) / 2}" fill="${stroke}"
                      font-size="140" font-weight="700" text-anchor="middle" dominant-baseline="middle">
                  Zone ${z}${zOcc ? " 👤" : ""}
                </text>
              </g>
            `;
          }
        }
      }
      radarSetHtml(zonesLayer, zonesHtml);
    }

    const masksLayer = this.shadowRoot.getElementById("masksLayer");
    radarSetHtml(masksLayer, "");

    // Render Targets & Motion Trails
    const targetsLayer = this.shadowRoot.getElementById("targetsLayer");
    const trailsLayer = this.shadowRoot.getElementById("trailsLayer");
    let targetsHtml = "";
    let trailsHtml = "";

    for (let t = 1; t <= 3; t++) {
      const tx = getVal(ent[`target${t}_x`], NaN);
      const ty = getVal(ent[`target${t}_y`], NaN);
      const speed = getVal(ent[`target${t}_speed`], 0);
      const dist = getVal(ent[`target${t}_distance`], 0);
      const elVal = this.shadowRoot.getElementById(`valT${t}`);
      const isTargetActive = Number.isFinite(tx) && Number.isFinite(ty) && dist > 0;

      if (isTargetActive) {
        const pt = RoomGeometry.transformPoint(tx, ty, geom);
        const rotPt = RoomGeometry.rotateToRoomAligned(tx, ty, geom.angle || 0, Boolean(geom.invertX));
        const speedEntity = states[ent[`target${t}_speed`]];
        const speedUnit = (speedEntity && speedEntity.attributes && speedEntity.attributes.unit_of_measurement) || "mm/s";
        const speedCmS = speedUnit === "mm/s" ? (speed / 10.0) : (speedUnit === "m/s" ? (speed * 100.0) : speed);
        
        // Update Trail
        // Only extend the trail when the target actually moved
        const trail = this._trails[t];
        const lastPt = trail[trail.length - 1];
        if (!lastPt || Math.abs(lastPt.x - pt.x) > 1 || Math.abs(lastPt.y - pt.y) > 1) {
          trail.push(pt);
          if (trail.length > 12) trail.shift();
        }

        // Trail path
        if (this._trails[t].length > 1) {
          const dStr = this._trails[t].map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
          trailsHtml += `<path d="${dStr}" fill="none" stroke="#38bdf8" stroke-width="8" opacity="0.4" stroke-dasharray="15,10" />`;
        }

        // Target Dot
        const targetColor = t === 1 ? "#38bdf8" : (t === 2 ? "#a855f7" : "#f59e0b");
        targetsHtml += `
          <circle cx="${pt.x}" cy="${pt.y}" r="140" fill="${targetColor}" opacity="0.3" filter="url(#glow)" />
          <circle cx="${pt.x}" cy="${pt.y}" r="80" fill="${targetColor}" stroke="#fff" stroke-width="16" />
          <text x="${pt.x}" y="${pt.y - 120}" fill="#fff" font-size="130" font-weight="800" text-anchor="middle">
            T${t} (${Math.round(dist)}mm)
          </text>
        `;

        if (elVal) {
          elVal.textContent = `X:${Math.round(rotPt.x)} Y:${Math.round(rotPt.y)} (${Math.round(speedCmS)}cm/s)`;
          elVal.style.color = targetColor;
        }
      } else {
        this._trails[t] = [];
        if (elVal) {
          elVal.textContent = "Inactive";
          elVal.style.color = "var(--text-muted)";
        }
      }

      const cardVal = this.shadowRoot.querySelectorAll(".detail-card")[t - 1];
      if (cardVal) {
        const distEntity = ent[`target${t}_distance`];
        cardVal.dataset.entity = distEntity || "";
        cardVal.title = distEntity ? `Click to view Target ${t} history (${distEntity})` : `Target ${t}`;
      }
    }

    radarSetHtml(targetsLayer, targetsHtml);
    radarSetHtml(trailsLayer, trailsHtml);
  }
}



// ====================================================================
// GUI EDITOR: RADAR CALIBRATION CARD EDITOR (Single-Render, Focus Preserving)
// ====================================================================
class RadarCalibrationCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({}, config);
    if (!this._rendered) {
      this._render();
    } else {
      this._updateFormValues();
    }
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;
    if (!this._rendered) {
      this._render();
    } else if (!oldHass) {
      this._updateDeviceOptions();
    }
  }

  _render() {
    if (!this._config) return;
    this._rendered = true;

    this.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px; padding:8px 0; font-family:var(--ha-font-family, sans-serif);">
        <div>
          <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:5px;">Select Presence Sensor</label>
          <select id="editorCalDeviceSelect" style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2);">
            <option value="">Select on drop-down</option>
          </select>
          <div style="font-size:0.75rem; color:var(--secondary-text-color, #94a3b8); margin-top:4px;">
            Choose a specific room to pin this card, or keep "Select on drop-down" to switch sensors directly from the card header.
          </div>
        </div>

        <div>
          <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:5px;">Card Title</label>
          <input type="text" id="editorCalTitleInput" value="${this._config.title || "Presence Onboarding & Calibration Suite"}"
                 style="width:100%; padding:8px 10px; border-radius:6px; background:var(--card-background-color, #1e293b); color:var(--primary-text-color, #fff); border:1px solid rgba(255,255,255,0.2); box-sizing:border-box;" />
        </div>

        ${RadarFloorplanManager.renderEditorSection("calFpEdit")}
      </div>
    `;

    this._updateDeviceOptions();

    const selDevice = this.querySelector("#editorCalDeviceSelect");
    const inpTitle = this.querySelector("#editorCalTitleInput");

    const notify = () => {
      const newConfig = Object.assign({}, this._config, {
        device: selDevice.value,
        title: inpTitle.value
      });
      this._config = newConfig;
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: newConfig },
        bubbles: true,
        composed: true
      }));
    };

    selDevice.addEventListener("change", () => {
      notify();
      const fpDevSel = this.querySelector("#calFpEditDeviceSelect");
      if (fpDevSel && selDevice.value) {
        fpDevSel.value = selDevice.value;
        RadarFloorplanManager.updateEditorForm(this, "calFpEdit", this);
      }
    });
    inpTitle.addEventListener("input", notify);

    RadarFloorplanManager.attachEditorEvents(this, "calFpEdit", this);
    RadarFloorplanManager.updateEditorForm(this, "calFpEdit", this);
  }

  _updateDeviceOptions() {
    if (!this._hass) return;
    const sel = this.querySelector("#editorCalDeviceSelect");
    if (!sel) return;

    const devices = RadarEntityResolver.getDevices(this._hass);
    const curVal = (this._config && this._config.device) || "";

    sel.innerHTML = `
      <option value="">Select on drop-down</option>
      ${devices.map(d => `<option value="${d.prefix}" ${curVal === d.prefix ? "selected" : ""}>${d.name} (${d.prefix})</option>`).join("")}
    `;
    sel.value = curVal;

    RadarFloorplanManager.updateEditorForm(this, "calFpEdit", this);
  }

  _updateFormValues() {
    if (!this._config) return;
    const inpTitle = this.querySelector("#editorCalTitleInput");
    if (inpTitle && document.activeElement !== inpTitle) {
      inpTitle.value = this._config.title || "Presence Onboarding & Calibration Suite";
    }
    const selDevice = this.querySelector("#editorCalDeviceSelect");
    if (selDevice && document.activeElement !== selDevice) {
      selDevice.value = this._config.device || "";
    }
    RadarFloorplanManager.updateEditorForm(this, "calFpEdit", this);
  }
}

// ====================================================================
// CARD 2: RADAR CALIBRATION CARD (<radar-calibration-card>)
// ====================================================================
class RadarCalibrationCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._selectedDevice = "";
    this._activeTab = "placement";
    this._selectedZone = 1;
    this._locallyEnabledZones = new Set();
    this._zoneDirty = false;
    this._lastSyncedZoneSig = "";
    this._toastMsg = "";
    this._toastTimeout = null;
    this._syncHandler = null;
    this._formState = {
      device: "",
      preset: "center",
      roomWidth: 4000,
      roomDepth: 5000,
      sensorOffsetX: 0,
      mountingYaw: 0
    };
    this._mapEditMode = false;
    this._mapSnapGrid = 50;
    this._activeDrag = null;
    this._zoneEditCoords = {};
    this._modifiedZones = new Set();
    this._initialEditSnapshot = null;
  }

  static getConfigElement() {
    return document.createElement("radar-calibration-card-editor");
  }

  static getStubConfig() {
    return {
      title: "Presence Onboarding & Calibration Suite",
      device: ""
    };
  }

  setConfig(config) {
    this._config = Object.assign({
      title: "Presence Onboarding & Calibration Suite",
      device: ""
    }, config);

    if (this._config.device) {
      this._selectedDevice = this._config.device;
    }

    if (this._rendered && this._hass) {
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
      this._resetLiveCaches();
      this._renderFull();
    }
  }

  _resetLiveCaches() {
    this._watchIds = null;
    this._lastLiveSig = null;
    this._lastRoomSig = null;
  }

  connectedCallback() {
    this._syncHandler = (e) => {
      if (!this._config.device && e.detail && e.detail.device && e.detail.device !== this._selectedDevice) {
        this._switchDevice(e.detail.device, false);
      }
    };
    window.addEventListener("radar-device-selected", this._syncHandler);

    // Re-resolve entity IDs once the HA entity registry arrives / changes
    this._unsubRegistry = RadarEntityResolver.onRegistryChange(() => {
      if (!this._hass || !this._rendered || this._emptyState) return;
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
      this._watchIds = null;
      this._lastLiveSig = null;
      this._updateLiveValues();
    });
  }

  disconnectedCallback() {
    if (this._syncHandler) {
      window.removeEventListener("radar-device-selected", this._syncHandler);
      this._syncHandler = null;
    }
    if (this._unsubRegistry) {
      this._unsubRegistry();
      this._unsubRegistry = null;
    }
  }

  _switchDevice(device, broadcast) {
    this._selectedDevice = device;
    this._locallyEnabledZones = new Set();
    if (this._mapEditMode) {
      this._mapEditMode = false;
      this._activeDrag = null;
    }
    this._resetLiveCaches();
    if (!this._hass) return;
    this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
    const sel = this.shadowRoot.getElementById("activeDeviceSelect");
    if (sel && sel.value !== device) sel.value = device;
    if (broadcast) {
      window.dispatchEvent(new CustomEvent("radar-device-selected", { detail: { device } }));
    }
    this._initFormStateFromEntities();
    this._updateViewfinder();
    this._updateLiveValues();
  }

  set hass(hass) {
    this._hass = hass;
    RadarEntityResolver.loadEntityRegistry(hass);

    if (!this._selectedDevice) {
      if (this._config && this._config.device) {
        this._selectedDevice = this._config.device;
      } else {
        const devs = RadarEntityResolver.getDevices(hass);
        if (devs.length > 0) {
          this._selectedDevice = devs[0].prefix;
        }
      }
    }

    if (!this._rendered) {
      this._entities = RadarEntityResolver.resolve(hass, { device: this._selectedDevice });
      this._rendered = true;
      this._renderFull();
      return;
    }

    if (this._emptyState || (this._entities && !hass.states[this._entities.target1_x])) {
      // Throttled re-discovery so the card enters / leaves the empty state without a page reload
      const now = Date.now();
      if (!this._lastDevCheck || now - this._lastDevCheck > 3000) {
        this._lastDevCheck = now;
        const devs = RadarEntityResolver.getDevices(hass);
        if ((devs.length > 0) === Boolean(this._emptyState)) {
          if (devs.length > 0 && !devs.some(d => d.prefix === this._selectedDevice)) {
            this._selectedDevice = (this._config && this._config.device) || devs[0].prefix;
          }
          this._entities = RadarEntityResolver.resolve(hass, { device: this._selectedDevice });
          this._resetLiveCaches();
          this._renderFull();
          return;
        }
      }
    }

    if (this._emptyState) return;
    this._updateLiveValues();
  }

  _showToast(msg) {
    this._toastMsg = msg;
    const toast = this.shadowRoot.getElementById("toastBanner");
    if (toast) {
      toast.textContent = msg;
      toast.style.display = "block";
      clearTimeout(this._toastTimeout);
      this._toastTimeout = setTimeout(() => {
        toast.style.display = "none";
      }, 3500);
    }
  }

  _callService(domain, service, data) {
    if (!this._hass) return Promise.reject(new Error("No HASS instance"));
    const p = this._hass.callService(domain, service, data);
    if (p && p.catch) {
      p.catch((err) => {
        console.warn(`[PRESENCE-RADAR-CARDS] ${domain}.${service} failed`, data, err);
        this._showToast(`⚠️ ${domain}.${service} failed: ${(err && err.message) || "check the sensor is online"}`);
      });
    }
    return p;
  }

  _setNumber(entityId, value) {
    if (!entityId || !this._hass || !this._hass.states[entityId]) return Promise.resolve();
    return this._callService("number", "set_value", { entity_id: entityId, value: value });
  }

  _pressButton(entityId) {
    if (!entityId || !this._hass || !this._hass.states[entityId]) return;
    this._callService("button", "press", { entity_id: entityId });
  }

  _openMoreInfo(entityId) {
    if (!entityId) return;
    const event = new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: { entityId }
    });
    this.dispatchEvent(event);
    window.dispatchEvent(event);
  }

  _setSelect(entityId, option) {
    if (!entityId || !this._hass || !this._hass.states[entityId]) return;
    this._callService("select", "select_option", { entity_id: entityId, option: option });
  }

  _toggleSwitch(entityId) {
    if (!entityId || !this._hass || !this._hass.states[entityId]) return;
    this._callService("switch", "toggle", { entity_id: entityId });
  }

  _initFormStateFromEntities() {
    if (!this._entities || !this._hass) return;
    const stableHass = radarStableHass(this._hass);
    RadarUpdateManager.updateBanner(this.shadowRoot, "calUpd", stableHass, this._entities, this._selectedDevice, this);
    const ent = this._entities;
    const states = stableHass.states;

    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };

    this._syncPlacementFromEntities();
    this._zoneDirty = false;
    this._lastRenderedZone = null;

    // Populate Tab 3 Engine Inputs
    const setInp = (id, val) => {
      const el = this.shadowRoot.getElementById(id);
      if (el) el.value = val;
    };
    setInp("inpMaxDistance", getVal(ent.max_distance, 6000));
    setInp("inpPresenceTimeout", getVal(ent.presence_timeout, 5));
    setInp("inpZoneOffDelay", getVal(ent.zone_off_delay, 5));
    setInp("inpStationaryTimeout", getVal(ent.stationary_latch_timeout, 30));
    setInp("inpExitMargin", getVal(ent.exit_trajectory_margin, 400));

    const chkStat = this.shadowRoot.getElementById("chkStationaryMemory");
    if (chkStat) chkStat.checked = (ent.stationary_memory_switch && states[ent.stationary_memory_switch] && states[ent.stationary_memory_switch].state === "on");

    const chkMulti = this.shadowRoot.getElementById("chkMultiTarget");
    if (chkMulti) chkMulti.checked = (ent.multi_target && states[ent.multi_target] && states[ent.multi_target].state === "on");

    // Hardware Exclusion Mode & Mask Inputs (legacy firmware only)
    const selExcl = this.shadowRoot.getElementById("selExclusionMode");
    if (selExcl) {
      const curMode = (ent.exclusion_mode && states[ent.exclusion_mode]) ? states[ent.exclusion_mode].state : "Disabled";
      selExcl.value = ["Disabled", "Filter", "Detection"].includes(curMode) ? curMode : "Disabled";
    }
    for (let m = 1; m <= 3; m++) {
      setInp(`inpMask${m}_x1`, getVal(ent[`mask${m}_x1`]));
      setInp(`inpMask${m}_y1`, getVal(ent[`mask${m}_y1`]));
      setInp(`inpMask${m}_x2`, getVal(ent[`mask${m}_x2`]));
      setInp(`inpMask${m}_y2`, getVal(ent[`mask${m}_y2`]));
    }
  }

  // Signature of the ESP32's room geometry entities (last-known-good values)
  _roomSig() {
    const ent = this._entities || {};
    const st = radarStableHass(this._hass).states;
    return [ent.room_width, ent.room_depth, ent.sensor_wall_offset_x, ent.mounting_angle,
            ent.invert_x_switch, ent.room_min_x, ent.room_max_x, ent.room_max_y]
      .map(id => (id && st[id]) ? st[id].state : "-").join("|");
  }

  // Loads Tab 1 (placement & room) from the ESP32. Called on device switch and whenever the
  // ESP32 values change while the user has no unsaved Tab 1 edits.
  _syncPlacementFromEntities() {
    if (!this._entities || !this._hass) return;
    const ent = this._entities;
    const states = radarStableHass(this._hass).states;
    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };

    const rw = getVal(ent.room_width, 0) || Math.abs(getVal(ent.room_max_x, 2500) - getVal(ent.room_min_x, -2500)) || 4000;
    const rd = getVal(ent.room_depth, 0) || getVal(ent.room_max_y, 5000) || 5000;
    const off = getVal(ent.sensor_wall_offset_x, 0);
    const yaw = getVal(ent.mounting_angle, 0);

    let preset = "center";
    if (Math.abs(yaw - (-45)) < 2 && off <= -Math.round(rw / 3)) preset = "corner_45_left";
    else if (Math.abs(yaw - 45) < 2 && off >= Math.round(rw / 3)) preset = "corner_45_right";
    else if (yaw === 0 && off <= -Math.round(rw / 3)) preset = "left_corner";
    else if (yaw === 0 && off >= Math.round(rw / 3)) preset = "right_corner";
    else if (yaw === 0 && off === 0) preset = "center";
    else preset = "custom";

    const invX = Boolean(ent.invert_x_switch && states[ent.invert_x_switch] && states[ent.invert_x_switch].state === "on");

    this._formState = {
      device: this._selectedDevice,
      preset: preset,
      roomWidth: Math.round(rw),
      roomDepth: Math.round(rd),
      sensorOffsetX: Math.round(off),
      mountingYaw: Math.round(yaw),
      invertX: invX
    };
    this._lastRoomSig = this._roomSig();
    this._placementDirty = false;

    const selPreset = this.shadowRoot.getElementById("selPlacementPreset");
    if (selPreset) selPreset.value = preset;
    const inpW = this.shadowRoot.getElementById("inpRoomWidth");
    if (inpW) inpW.value = this._formState.roomWidth;
    const inpD = this.shadowRoot.getElementById("inpRoomDepth");
    if (inpD) inpD.value = this._formState.roomDepth;
    const inpOff = this.shadowRoot.getElementById("inpWallOffsetX");
    if (inpOff) inpOff.value = this._formState.sensorOffsetX;
    const inpYaw = this.shadowRoot.getElementById("inpMountingYaw");
    if (inpYaw) inpYaw.value = this._formState.mountingYaw;
    const chkInvX = this.shadowRoot.getElementById("chkInvertX");
    if (chkInvX) chkInvX.checked = invX;
  }

  _renderFull() {
    const devices = RadarEntityResolver.getDevices(this._hass);
    this._emptyState = devices.length === 0;

    if (devices.length === 0) {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            font-family: var(--ha-font-family, 'Segoe UI', Roboto, sans-serif);
            color-scheme: dark;
            --card-bg: var(--ha-card-background, var(--card-background-color, #0f172a));
            --primary-color: #38bdf8;
            --text-color: var(--primary-text-color, #f8fafc);
            --text-muted: var(--secondary-text-color, #94a3b8);
            --border-color: rgba(255, 255, 255, 0.1);
          }
          ha-card {
            background: var(--card-bg);
            border-radius: 16px;
            border: 1px solid var(--border-color);
            padding: 36px 20px;
            color: var(--text-color);
            text-align: center;
          }
          .btn-primary {
            background: var(--primary-color);
            color: #0f172a;
            border: none;
            padding: 10px 22px;
            border-radius: 8px;
            font-size: 0.9rem;
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
          }
          .btn-secondary {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-color);
            color: var(--text-color);
            border-radius: 8px;
          }
        </style>
        <ha-card>
          <div style="font-size: 3rem; margin-bottom: 12px;">📡</div>
          <div style="font-size: 1.25rem; font-weight: 700; margin-bottom: 6px;">No Presence Sensors Found</div>
          <div style="font-size: 0.85rem; color: var(--text-muted); max-width: 420px; margin: 0 auto 20px; line-height: 1.5;">
            No HLK-LD2450 radar sensors were detected in Home Assistant yet. Use our 1-minute setup wizard to configure and add your first sensor.
          </div>
          <button class="btn-primary" id="btnEmptySetupGuide">
            ⚡ Quick Setup Guide & YAML Generator
          </button>
          ${RadarSetupWizard.renderModalHtml("calWz", this._hass)}
        </ha-card>
      `;
      RadarSetupWizard.attachEvents(this.shadowRoot, "calWz", null, this);
      const btn = this.shadowRoot.getElementById("btnEmptySetupGuide");
      if (btn) btn.addEventListener("click", () => RadarSetupWizard.open(this.shadowRoot, "calWz"));
      return;
    }

    const hasPinnedDevice = Boolean(this._config && this._config.device);
    const updateStatus = RadarUpdateManager.checkStatus(this._hass, this._entities, this._selectedDevice);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--ha-font-family, 'Segoe UI', Roboto, sans-serif);
          color-scheme: dark;
          --card-bg: var(--ha-card-background, var(--card-background-color, #0f172a));
          --primary-color: #38bdf8;
          --primary-hover: #0284c7;
          --occupied-color: #10b981;
          --warning-color: #f59e0b;
          --danger-color: #ef4444;
          --text-color: var(--primary-text-color, #f8fafc);
          --text-muted: var(--secondary-text-color, #94a3b8);
          --border-color: rgba(255, 255, 255, 0.1);
        }
        ha-card {
          background: var(--card-bg);
          border-radius: 16px;
          border: 1px solid var(--border-color);
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
          overflow: hidden;
          padding: 16px;
          color: var(--text-color);
          container-type: inline-size;
        }
        .header {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 16px;
        }
        .header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }
        .title-wrapper {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 0 auto;
        }
        .card-icon {
          width: 24px;
          height: 24px;
          fill: var(--primary-color);
          flex-shrink: 0;
        }
        .card-title {
          font-size: 1.15rem;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .device-selector-wrapper {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 1 280px;
          width: 100%;
          max-width: 280px;
          height: auto;
        }
        .device-select {
          width: 100%;
          padding: 8px 12px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-color, #f8fafc);
          border: 1px solid var(--border-color);
          font-size: 0.88rem;
          font-weight: 600;
          cursor: pointer;
          outline: none;
          box-sizing: border-box;
          height: 40px;
          color-scheme: dark;
        }
        .device-select:focus {
          border-color: var(--primary-color);
        }
        .device-select option {
          background-color: #1e293b;
          color: #f8fafc;
        }
        .device-select option[value="__new__"] {
          background-color: #1e293b;
          color: #38bdf8;
          font-weight: 700;
        }
        .form-select {
          color-scheme: dark;
        }
        .form-select option {
          background-color: #1e293b;
          color: #f8fafc;
        }
        @container (max-width: 520px) {
          .title-wrapper {
            flex: 0 0 100%;
            width: 100%;
          }
          .device-selector-wrapper {
            flex: 0 0 auto;
            max-width: 100%;
            width: 100%;
          }
        }
        @media (max-width: 520px) {
          .title-wrapper {
            flex: 0 0 100%;
            width: 100%;
          }
          .device-selector-wrapper {
            flex: 0 0 auto;
            max-width: 100%;
            width: 100%;
          }
        }
        .btn-restart {
          padding: 7px 12px;
          border-radius: 8px;
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #f87171;
          font-size: 0.75rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.2s;
        }
        .btn-restart:hover {
          background: rgba(239, 68, 68, 0.25);
        }
        .chips-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 20px;
          font-size: 0.75rem;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--border-color);
          cursor: pointer;
          user-select: none;
          transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .chip:hover {
          transform: translateY(-1px);
          border-color: var(--primary-color);
          background: rgba(255, 255, 255, 0.12);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        }
        .chip:active {
          transform: translateY(0);
        }
        .chip.occupied {
          background: rgba(16, 185, 129, 0.15);
          border-color: rgba(16, 185, 129, 0.4);
          color: #34d399;
        }
        .chip.occupied:hover {
          background: rgba(16, 185, 129, 0.25);
          border-color: #34d399;
        }
        .chip.latched {
          background: rgba(168, 85, 247, 0.15);
          border-color: rgba(168, 85, 247, 0.4);
          color: #c084fc;
        }
        .chip.latched:hover {
          background: rgba(168, 85, 247, 0.25);
          border-color: #c084fc;
        }
        .tabs-nav {
          display: flex;
          border-bottom: 1px solid var(--border-color);
          margin-bottom: 16px;
          gap: 4px;
          overflow-x: auto;
        }
        .tab-btn {
          padding: 8px 14px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: all 0.2s;
          white-space: nowrap;
        }
        .tab-btn:hover {
          color: var(--text-color);
        }
        .tab-btn.active {
          color: var(--primary-color);
          border-bottom-color: var(--primary-color);
          font-weight: 700;
        }
        .tab-pane {
          display: none;
        }
        .tab-pane.active {
          display: block;
        }
        .toast-banner {
          display: none;
          background: rgba(16, 185, 129, 0.2);
          border: 1px solid rgba(16, 185, 129, 0.5);
          color: #34d399;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 0.85rem;
          font-weight: 600;
          margin-bottom: 14px;
          text-align: center;
        }
        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
          margin-bottom: 14px;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .form-label {
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--text-muted);
        }
        .form-input, .form-select {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          padding: 8px 12px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid var(--border-color);
          color: var(--text-color);
          font-size: 0.88rem;
          outline: none;
        }
        .form-group {
          min-width: 0;
          box-sizing: border-box;
        }
        .stepper-box {
          min-width: 0;
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
          overflow: hidden;
        }
        .zones-grid {
          min-width: 0;
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
        }
        .zone-card {
          min-width: 0;
          box-sizing: border-box;
        }
        .form-input:focus, .form-select:focus {
          border-color: var(--primary-color);
        }
        .action-row {
          display: flex;
          gap: 10px;
          margin-top: 14px;
          flex-wrap: wrap;
        }
        .btn-primary {
          background: var(--primary-color);
          color: #0f172a;
          border: none;
          padding: 10px 18px;
          border-radius: 8px;
          font-size: 0.85rem;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: background 0.2s;
        }
        .btn-primary:hover {
          background: var(--primary-hover);
          color: #fff;
        }
        .btn-secondary {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-color);
          border: 1px solid var(--border-color);
          padding: 10px 16px;
          border-radius: 8px;
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }
        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.12);
        }
        .btn-danger {
          background: rgba(239, 68, 68, 0.15);
          color: #f87171;
          border: 1px solid rgba(239, 68, 68, 0.3);
          padding: 8px 14px;
          border-radius: 8px;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-danger:hover {
          background: rgba(239, 68, 68, 0.25);
        }
        .vf-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 10px;
          margin-bottom: 6px;
        }
        .vf-header-title {
          font-size: 0.85rem;
          font-weight: 700;
          color: var(--text-muted);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .btn-vf-edit {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 14px;
          border-radius: 8px;
          background: rgba(56, 189, 248, 0.12);
          border: 1px solid rgba(56, 189, 248, 0.35);
          color: #38bdf8;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-vf-edit:hover, .btn-vf-edit.active {
          background: #38bdf8;
          color: #0f172a;
          box-shadow: 0 0 14px rgba(56, 189, 248, 0.5);
        }
        .vf-edit-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px 12px;
          background: rgba(56, 189, 248, 0.08);
          border: 1px solid rgba(56, 189, 248, 0.3);
          border-radius: 8px;
          margin-bottom: 8px;
          animation: radarFadeIn 0.25s ease-in-out;
        }
        .vf-edit-badge {
          background: #38bdf8;
          color: #0f172a;
          font-size: 0.72rem;
          font-weight: 800;
          padding: 2px 6px;
          border-radius: 4px;
          letter-spacing: 0.05em;
        }
        .vf-edit-hint {
          font-size: 0.78rem;
          color: var(--text-muted);
        }
        .btn-vf-snap {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid var(--border-color);
          color: var(--text-color);
          padding: 5px 10px;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .btn-vf-snap:hover {
          background: rgba(255, 255, 255, 0.15);
        }
        .mini-viewfinder {
          width: 100%;
          aspect-ratio: 16 / 10;
          background: radial-gradient(circle at 50% 10%, #1e293b 0%, #0f172a 80%);
          border-radius: 12px;
          border: 1px solid var(--border-color);
          overflow: hidden;
          margin: 10px 0 14px 0;
          position: relative;
          touch-action: pan-y;
        }
        .mini-viewfinder svg {
          touch-action: pan-y;
        }
        .mini-viewfinder.editing {
          border: 2px solid #38bdf8;
          box-shadow: 0 0 20px rgba(56, 189, 248, 0.25);
          touch-action: none;
        }
        .mini-viewfinder.editing svg {
          touch-action: none;
        }
        .vf-handle {
          pointer-events: all;
          transition: filter 0.15s;
        }
        .vf-handle:hover {
          filter: drop-shadow(0 0 10px #38bdf8);
        }
        .vf-zone-group {
          cursor: pointer;
        }
        .vf-zone-group polygon {
          pointer-events: all;
          transition: stroke-width 0.2s ease, filter 0.2s ease;
        }
        .vf-zone-group text {
          pointer-events: none;
        }
        .vf-zone-group:hover polygon {
          filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.8));
        }
        .vf-zone-group.exclusion:hover polygon {
          filter: drop-shadow(0 0 10px rgba(239, 68, 68, 0.8));
        }
        .zones-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 12px;
          margin-bottom: 16px;
        }
        .zone-card {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-color);
          border-radius: 10px;
          padding: 12px;
          cursor: pointer;
          transition: border-color 0.2s, background 0.2s;
        }
        .zone-card:hover {
          background: rgba(255, 255, 255, 0.05);
        }
        .zone-card.selected {
          border-color: var(--primary-color);
          background: rgba(56, 189, 248, 0.08);
        }
        .zone-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .zone-card-title {
          font-size: 0.88rem;
          font-weight: 700;
        }
        .zone-status-badge {
          font-size: 0.7rem;
          padding: 2px 8px;
          border-radius: 10px;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.1);
        }
        .zone-status-badge.occupied {
          background: rgba(16, 185, 129, 0.2);
          color: #34d399;
        }
        .zone-coords-info {
          font-size: 0.75rem;
          color: var(--text-muted);
          line-height: 1.4;
        }
        .stepper-box {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 16px;
        }
        .stepper-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
        }
        .stepper-step-pill {
          background: var(--primary-color);
          color: #0f172a;
          font-size: 0.75rem;
          font-weight: 800;
          padding: 2px 8px;
          border-radius: 12px;
        }
        .stepper-title {
          font-size: 0.95rem;
          font-weight: 700;
        }
        .stepper-instruction {
          font-size: 0.82rem;
          color: var(--text-muted);
          margin-bottom: 14px;
          line-height: 1.4;
        }
        .nudge-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 8px;
          margin: 12px 0;
        }
        .nudge-group {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 8px;
          text-align: center;
        }
        .nudge-label {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-bottom: 6px;
          font-weight: 600;
        }
        .nudge-btn-row {
          display: flex;
          justify-content: center;
          gap: 6px;
        }
        .btn-nudge {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid var(--border-color);
          color: var(--text-color);
          border-radius: 4px;
          padding: 4px 8px;
          font-size: 0.75rem;
          font-weight: 700;
          cursor: pointer;
        }
        .btn-nudge:hover {
          background: var(--primary-color);
          color: #0f172a;
        }
        .setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid var(--border-color);
          gap: 16px;
        }
        .setting-info {
          flex: 1;
        }
        .setting-title {
          font-size: 0.85rem;
          font-weight: 600;
        }
        .setting-desc {
          font-size: 0.75rem;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .setting-control {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        /* Firmware & YAML Update Alert Banner */
        .radar-update-container {
          width: 100%;
        }
        .radar-update-banner {
          background: rgba(245, 158, 11, 0.12);
          border: 1px solid rgba(245, 158, 11, 0.45);
          border-radius: 12px;
          padding: 12px 14px;
          margin-bottom: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: radarFadeIn 0.3s ease-in-out;
          box-sizing: border-box;
        }
        .radar-update-banner.available {
          background: rgba(56, 189, 248, 0.12);
          border-color: rgba(56, 189, 248, 0.45);
        }
        .radar-update-banner-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
        }
        .radar-update-banner-content {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          flex: 1;
          min-width: 0;
        }
        .radar-update-icon {
          font-size: 1.25rem;
          line-height: 1;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .radar-update-title {
          font-size: 0.86rem;
          font-weight: 700;
          color: #fbbf24;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .radar-update-banner.available .radar-update-title {
          color: #38bdf8;
        }
        .radar-update-badge {
          font-size: 0.7rem;
          font-weight: 600;
          background: rgba(245, 158, 11, 0.22);
          border: 1px solid rgba(245, 158, 11, 0.4);
          color: #fbbf24;
          padding: 1px 6px;
          border-radius: 4px;
        }
        .radar-update-banner.available .radar-update-badge {
          background: rgba(56, 189, 248, 0.2);
          border-color: rgba(56, 189, 248, 0.4);
          color: #38bdf8;
        }
        .radar-update-sub {
          font-size: 0.78rem;
          color: var(--text-color, #f8fafc);
          opacity: 0.88;
          line-height: 1.4;
          margin-top: 3px;
        }
        .radar-update-btn-close {
          background: transparent;
          border: none;
          color: var(--text-muted, #94a3b8);
          font-size: 1.1rem;
          cursor: pointer;
          padding: 0 4px;
          line-height: 1;
          opacity: 0.7;
          border-radius: 4px;
        }
        .radar-update-btn-close:hover {
          opacity: 1;
          color: var(--text-color, #f8fafc);
        }
        .radar-update-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding-left: 30px;
        }
        .btn-update-primary {
          background: #f59e0b;
          color: #0f172a;
          border: none;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: background 0.15s, box-shadow 0.15s;
        }
        .btn-update-primary:hover {
          background: #fbbf24;
          box-shadow: 0 2px 8px rgba(245, 158, 11, 0.4);
        }
        .radar-update-banner.available .btn-update-primary {
          background: #38bdf8;
        }
        .radar-update-banner.available .btn-update-primary:hover {
          background: #7dd3fc;
          box-shadow: 0 2px 8px rgba(56, 189, 248, 0.4);
        }
        .btn-update-secondary {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-color, #f8fafc);
          border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: background 0.15s;
        }
        .btn-update-secondary:hover {
          background: rgba(255, 255, 255, 0.14);
        }
        .btn-update-link {
          background: transparent;
          border: none;
          color: var(--primary-color, #38bdf8);
          font-size: 0.76rem;
          font-weight: 600;
          cursor: pointer;
          padding: 4px 6px;
          text-decoration: underline;
        }
        @keyframes radarFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      </style>

      <ha-card>
        <!-- Header -->
        <div class="header">
          <div class="header-top">
            <div class="title-wrapper">
              <svg class="card-icon" viewBox="0 0 24 24">
                <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A3,3 0 0,1 15,8A3,3 0 0,1 12,11A3,3 0 0,1 9,8A3,3 0 0,1 12,5M17.13,17C15.92,18.85 14.11,20.24 12,20.92C9.89,20.24 8.08,18.85 6.87,17C6.53,16.5 6.24,16 6,15.47C6,13.82 8.71,12.47 12,12.47C15.29,12.47 18,13.82 18,15.47C17.76,16 17.47,16.5 17.13,17Z"/>
              </svg>
              <div class="card-title">${this._config.title || "Presence Onboarding & Calibration Suite"}</div>
            </div>

            <div class="device-selector-wrapper" style="${hasPinnedDevice ? "display: none;" : ""}">
              <select id="activeDeviceSelect" class="device-select">
                ${devices.map(d => `<option value="${d.prefix}" ${this._selectedDevice === d.prefix ? "selected" : ""}>${d.name}</option>`).join("")}
                <option value="__new__" style="color:var(--primary-color); font-weight:700;">➕ Add New Sensor...</option>
              </select>
            </div>
          </div>

          <!-- Diagnostic Chips -->
          <div class="chips-bar" id="calChipsBar">
            <div class="chip" id="chipCalOcc">⚪ Clear</div>
            <div class="chip" id="chipCalTargets">🎯 0 Targets</div>
            <div class="chip" id="chipCalLatch" style="display:none;">🧠 Latched</div>
            <div class="chip" id="chipCalWifi">📶 -- dBm</div>
          </div>
        </div>

        <div class="toast-banner" id="toastBanner"></div>

        <div id="calUpdUpdateBannerContainer" class="radar-update-container">
          ${RadarUpdateManager.renderBannerHtml(updateStatus, "calUpd", this._hass)}
        </div>

        <!-- Interactive Live Viewfinder Header -->
        <div class="vf-header">
          <div class="vf-header-title">
            <span>📡 Live Radar Map & Viewfinder</span>
          </div>
          <div>
            <button id="btnToggleMapEdit" class="btn-vf-edit ${this._mapEditMode ? "active" : ""}" title="Toggle Interactive Drag & Drop Map Editor">
              ${this._mapEditMode ? "✏️ Done Editing" : "✏️ Edit Map"}
            </button>
          </div>
        </div>

        <div id="vfEditToolbar" class="vf-edit-toolbar" style="${this._mapEditMode ? "display:flex;" : "display:none;"}">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="vf-edit-badge">EDIT MODE</span>
            <span class="vf-edit-hint">Drag walls to resize room • Drag sensor or beam to reposition • Drag/stretch zones</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <button id="btnToggleSnap" class="btn-vf-snap" title="Toggle Grid Snapping">
              🧲 Snap: ${this._mapSnapGrid ? this._mapSnapGrid + "mm" : "Off"}
            </button>
            <button id="btnSaveMapEdits" class="btn-primary" style="padding:5px 12px; font-size:0.8rem;">
              💾 Save to ESP32
            </button>
            <button id="btnCancelMapEdits" class="btn-secondary" style="padding:5px 10px; font-size:0.8rem;">
              ✕ Exit
            </button>
          </div>
        </div>

        <!-- Interactive Live Viewfinder SVG (Visible on ALL tabs!) -->
        <div class="mini-viewfinder ${this._mapEditMode ? "editing" : ""}" id="miniViewfinderBox">
          <svg id="viewfinderSvg" viewBox="-3000 -500 6000 6500" preserveAspectRatio="xMidYMid meet" style="width:100%; height:100%;">
            <defs>
              <radialGradient id="vfBeamGrad" cx="50%" cy="0%" r="100%">
                <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3" />
                <stop offset="70%" stop-color="#0284c7" stop-opacity="0.05" />
                <stop offset="100%" stop-color="#0284c7" stop-opacity="0" />
              </radialGradient>
              <pattern id="vfExclusionHatch" width="80" height="80" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="80" stroke="#ef4444" stroke-width="20" stroke-opacity="0.35" />
              </pattern>
              <clipPath id="vfRoomClip">
                <rect id="vfRoomClipRect" x="0" y="0" width="4000" height="5000" rx="6" />
              </clipPath>
            </defs>
            <g id="vfFloorplanLayer"></g>
            <g id="vfRoomLayer"></g>
            <g id="vfZonesLayer"></g>
            <g id="vfMasksLayer"></g>
            <path id="vfBeamCone" fill="url(#vfBeamGrad)" opacity="0.8" />
            <g id="vfTargetsLayer"></g>
            <g id="vfSensorLayer"></g>
            <g id="vfEditHandlesLayer"></g>
            <g id="vfHudLayer"></g>
          </svg>
        </div>

        <!-- Tabs Navigation -->
        <div class="tabs-nav">
          <button class="tab-btn ${this._activeTab === "placement" ? "active" : ""}" data-tab="placement">📐 Placement & Room</button>
          <button class="tab-btn ${this._activeTab === "zones" ? "active" : ""}" data-tab="zones">🎯 Multi-Mode Zones</button>
          <button class="tab-btn ${this._activeTab === "engine" ? "active" : ""}" data-tab="engine">⚙️ Engine & Sensitivity</button>
        </div>

        <!-- TAB 1: PLACEMENT & ROOM BOUNDARIES -->
        <div class="tab-pane ${this._activeTab === "placement" ? "active" : ""}" id="tabPlacement">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Sensor Placement Preset</label>
              <select class="form-select" id="selPlacementPreset">
                <option value="center">Center Wall (0°)</option>
                <option value="corner_45_left">Front-Left Corner (-45° Inward)</option>
                <option value="corner_45_right">Front-Right Corner (+45° Inward)</option>
                <option value="left_corner">Left Corner Flat (0°)</option>
                <option value="right_corner">Right Corner Flat (0°)</option>
                <option value="custom">Custom Offset & Yaw</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Room Width (mm)</label>
              <input type="number" class="form-input" id="inpRoomWidth" placeholder="e.g. 4000" />
            </div>

            <div class="form-group">
              <label class="form-label">Room Depth (mm)</label>
              <input type="number" class="form-input" id="inpRoomDepth" placeholder="e.g. 5000" />
            </div>

            <div class="form-group">
              <label class="form-label">Sensor Wall Offset X (mm)</label>
              <input type="number" class="form-input" id="inpWallOffsetX" placeholder="0 = Center" />
            </div>

            <div class="form-group">
              <label class="form-label">Mounting Yaw Angle (°)</label>
              <input type="number" class="form-input" id="inpMountingYaw" placeholder="0 = Facing Room" />
            </div>

            <div class="form-group" style="display:flex; flex-direction:column; justify-content:flex-end;">
              <label class="form-label">Enclosure Orientation</label>
              <label style="display:flex; align-items:center; gap:8px; font-size:0.84rem; cursor:pointer; padding:9px 10px; border-radius:8px; background:rgba(255,255,255,0.04); border:1px solid var(--border-color);">
                <input type="checkbox" id="chkInvertX" />
                <span>Upside-Down Mount (Flip X-Axis)</span>
              </label>
            </div>
          </div>



          <div class="action-row">
            <button class="btn-primary" id="btnSaveRoomFlash">⚡ Save & Flash Room Boundaries to ESP32</button>
            <button class="btn-secondary" id="btnResetRoomBounds">↺ Reset to Full Range</button>
          </div>
        </div>

        <!-- TAB 2: DETECTION & EXCLUSION ZONES (1 TO 10) -->
        <div class="tab-pane ${this._activeTab === "zones" ? "active" : ""}" id="tabZones">
          <div id="zonesToolbar"></div>
          <div class="zones-grid" id="zonesCardsGrid"></div>

          <div class="stepper-box" id="zoneStepperBox">
            <div class="stepper-header">
              <span class="stepper-step-pill" id="stepPill">Step 1 of 4</span>
              <span class="stepper-title" id="stepTitle">Select Zone to Calibrate</span>
            </div>
            <div class="stepper-instruction" id="stepInstruction">
              Choose which detection zone you want to set up (Zone 1 Couch, Zone 2 Desk, etc.).
            </div>

            <div id="stepInteractiveContent"></div>
          </div>
        </div>

        <!-- TAB 3: ENGINE & SENSITIVITY -->
        <div class="tab-pane ${this._activeTab === "engine" ? "active" : ""}" id="tabEngine">
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Maximum Detection Distance</div>
              <div class="setting-desc">Ignore all reflections and people beyond this distance (mm).</div>
            </div>
            <div class="setting-control">
              <input type="number" class="form-input" id="inpMaxDistance" style="width:90px;" />
              <button class="btn-secondary" style="padding:6px 10px;" id="btnSaveMaxDist">Set</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Presence Timeout</div>
              <div class="setting-desc">Seconds to maintain room presence after all motion disappears.</div>
            </div>
            <div class="setting-control">
              <input type="number" class="form-input" id="inpPresenceTimeout" style="width:90px;" />
              <button class="btn-secondary" style="padding:6px 10px;" id="btnSaveTimeout">Set</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Zone Off Delay</div>
              <div class="setting-desc">Seconds to wait before turning off zone occupancy.</div>
            </div>
            <div class="setting-control">
              <input type="number" class="form-input" id="inpZoneOffDelay" style="width:90px;" />
              <button class="btn-secondary" style="padding:6px 10px;" id="btnSaveZoneDelay">Set</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Stationary Presence Memory (Vanish Protection)</div>
              <div class="setting-desc">Prevents radar from dropping occupancy when a person sits completely still.</div>
            </div>
            <div class="setting-control">
              <input type="checkbox" id="chkStationaryMemory" style="transform:scale(1.3); cursor:pointer;" />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Stationary Latch Timeout</div>
              <div class="setting-desc">Minutes to preserve latch when stationary target sits or sleeps (default 30m).</div>
            </div>
            <div class="setting-control">
              <input type="number" class="form-input" id="inpStationaryTimeout" style="width:90px;" />
              <button class="btn-secondary" style="padding:6px 10px;" id="btnSaveStatTimeout">Set</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Exit Trajectory Margin</div>
              <div class="setting-desc">Margin in mm from boundaries to immediately release stationary memory on exit.</div>
            </div>
            <div class="setting-control">
              <input type="number" class="form-input" id="inpExitMargin" style="width:90px;" />
              <button class="btn-secondary" style="padding:6px 10px;" id="btnSaveExitMargin">Set</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Multi-Target Tracking (3 Targets)</div>
              <div class="setting-desc">Enable tracking up to 3 people simultaneously.</div>
            </div>
            <div class="setting-control">
              <input type="checkbox" id="chkMultiTarget" style="transform:scale(1.3); cursor:pointer;" />
            </div>
          </div>

          <div class="action-row" style="margin-top:20px;">
            <button class="btn-secondary" id="btnRestartSensor" title="Reboot ESP32 Node">🔄 Restart ESP32</button>
            <button class="btn-primary" id="btnRestartRadarChip" title="Restart LD2450 Radar Module">🔄 Restart Radar Module</button>
            <button class="btn-danger" id="btnFactoryResetRadar" title="Factory Reset LD2450">⚠️ Factory Reset Radar</button>
          </div>
        </div>
        ${RadarSetupWizard.renderModalHtml("calWz", this._hass)}
      </ha-card>
    `;

    RadarSetupWizard.attachEvents(this.shadowRoot, "calWz", (msg) => this._showToast(msg), this);
    RadarUpdateManager.attachEvents(this.shadowRoot, "calUpd", this._selectedDevice, this);

    this._bindEvents();
    this._initFormStateFromEntities();
    this._updateViewfinder();
    this._lastLiveSig = null;
    this._updateLiveValues();
  }

  _clientToSvg(e) {
    const svg = this.shadowRoot.getElementById("viewfinderSvg");
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  }

  _snap(val, step = this._mapSnapGrid) {
    if (!step || step <= 1) return Math.round(val);
    return Math.round(val / step) * step;
  }

  _initEditSnapshot() {
    const ent = this._entities;
    const stableHass = radarStableHass(this._hass);
    const states = stableHass.states;
    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };
    this._initialEditSnapshot = {
      formState: Object.assign({}, this._formState),
      zones: {}
    };
    for (let z = 1; z <= 10; z++) {
      this._initialEditSnapshot.zones[z] = {
        x1: getVal(ent[`zone${z}_x1`]),
        y1: getVal(ent[`zone${z}_y1`]),
        x2: getVal(ent[`zone${z}_x2`]),
        y2: getVal(ent[`zone${z}_y2`]),
        angle: getVal(ent[`zone${z}_angle`], 0)
      };
      if (!this._zoneEditCoords[z]) {
        this._zoneEditCoords[z] = Object.assign({}, this._initialEditSnapshot.zones[z]);
      }
    }
  }

  _toggleMapEdit(forceState = null) {
    this._mapEditMode = (forceState !== null) ? forceState : !this._mapEditMode;
    if (this._mapEditMode) {
      this._initEditSnapshot();
      this._showToast("✏️ Map Edit Mode: Drag walls, sensor, or zones directly!");
    } else {
      this._activeDrag = null;
    }
    const btn = this.shadowRoot.getElementById("btnToggleMapEdit");
    if (btn) {
      btn.className = `btn-vf-edit ${this._mapEditMode ? "active" : ""}`;
      btn.innerHTML = this._mapEditMode ? "✏️ Done Editing" : "✏️ Edit Map";
    }
    const toolbar = this.shadowRoot.getElementById("vfEditToolbar");
    if (toolbar) {
      toolbar.style.display = this._mapEditMode ? "flex" : "none";
    }
    const vfBox = this.shadowRoot.getElementById("miniViewfinderBox");
    if (vfBox) {
      vfBox.classList.toggle("editing", this._mapEditMode);
    }
    this._updateViewfinder();
  }

  async _saveMapEdits() {
    if (!this._entities || !this._hass) return;
    const ent = this._entities;
    this._showToast("💾 Saving layout & zones to ESP32...");

    const rw = this._formState.roomWidth || 4000;
    const rd = this._formState.roomDepth || 5000;
    const off = this._formState.sensorOffsetX || 0;
    const yaw = this._formState.mountingYaw || 0;

    // 1. Save Room Boundaries
    if (ent.room_width) await this._setNumber(ent.room_width, rw);
    if (ent.room_depth) await this._setNumber(ent.room_depth, rd);
    if (ent.sensor_wall_offset_x) await this._setNumber(ent.sensor_wall_offset_x, off);
    if (ent.mounting_angle) await this._setNumber(ent.mounting_angle, yaw);

    if (ent.apply_room_dimensions_btn && this._hass.states[ent.apply_room_dimensions_btn]) {
      this._pressButton(ent.apply_room_dimensions_btn);
    } else {
      const minX = -(rw * 0.5 + off);
      const maxX = +(rw * 0.5 - off);
      if (ent.room_min_x) await this._setNumber(ent.room_min_x, minX);
      if (ent.room_max_x) await this._setNumber(ent.room_max_x, maxX);
      if (ent.room_min_y) await this._setNumber(ent.room_min_y, 0);
      if (ent.room_max_y) await this._setNumber(ent.room_max_y, rd);
    }

    // 2. Save modified zones
    for (const z of this._modifiedZones) {
      const c = this._zoneEditCoords[z];
      if (c) {
        if (ent[`zone${z}_x1`]) await this._setNumber(ent[`zone${z}_x1`], c.x1);
        if (ent[`zone${z}_y1`]) await this._setNumber(ent[`zone${z}_y1`], c.y1);
        if (ent[`zone${z}_x2`]) await this._setNumber(ent[`zone${z}_x2`], c.x2);
        if (ent[`zone${z}_y2`]) await this._setNumber(ent[`zone${z}_y2`], c.y2);
        if (ent[`zone${z}_angle`]) await this._setNumber(ent[`zone${z}_angle`], c.angle || 0);
      }
    }

    this._modifiedZones.clear();
    this._placementDirty = false;
    this._zoneDirty = false;
    this._showToast("⚡ Successfully flashed updated room layout and zones to ESP32!");
    this._toggleMapEdit(false);
  }

  _cancelMapEdits() {
    if (this._initialEditSnapshot) {
      this._formState = Object.assign({}, this._initialEditSnapshot.formState);
      this._zoneEditCoords = {};
      for (const z in this._initialEditSnapshot.zones) {
        this._zoneEditCoords[z] = Object.assign({}, this._initialEditSnapshot.zones[z]);
      }
      this._modifiedZones.clear();
      const inpW = this.shadowRoot.getElementById("inpRoomWidth");
      if (inpW) inpW.value = this._formState.roomWidth;
      const inpD = this.shadowRoot.getElementById("inpRoomDepth");
      if (inpD) inpD.value = this._formState.roomDepth;
      const inpOff = this.shadowRoot.getElementById("inpWallOffsetX");
      if (inpOff) inpOff.value = this._formState.sensorOffsetX;
      const inpYaw = this.shadowRoot.getElementById("inpMountingYaw");
      if (inpYaw) inpYaw.value = this._formState.mountingYaw;
    }
    this._toggleMapEdit(false);
    this._showToast("Map edits discarded.");
  }

  _syncZoneInputsIfSelected(z) {
    if (z === this._selectedZone) {
      const c = this._zoneEditCoords[z];
      if (!c) return;
      const setInp = (id, val) => {
        const el = this.shadowRoot.getElementById(id);
        if (el) el.value = Math.round(val);
      };
      setInp("inpZone_x1", c.x1);
      setInp("inpZone_y1", c.y1);
      setInp("inpZone_x2", c.x2);
      setInp("inpZone_y2", c.y2);
      setInp("inpZone_angle", c.angle || 0);
    }
  }

  _bindMapEditEvents() {
    const btnToggle = this.shadowRoot.getElementById("btnToggleMapEdit");
    if (btnToggle) {
      btnToggle.addEventListener("click", () => this._toggleMapEdit());
    }

    const btnSnap = this.shadowRoot.getElementById("btnToggleSnap");
    if (btnSnap) {
      btnSnap.addEventListener("click", () => {
        if (this._mapSnapGrid === 50) this._mapSnapGrid = 100;
        else if (this._mapSnapGrid === 100) this._mapSnapGrid = 0;
        else this._mapSnapGrid = 50;
        btnSnap.textContent = `🧲 Snap: ${this._mapSnapGrid ? this._mapSnapGrid + "mm" : "Off"}`;
        this._showToast(`Grid snap: ${this._mapSnapGrid ? this._mapSnapGrid + " mm" : "Disabled"}`);
      });
    }

    const btnSave = this.shadowRoot.getElementById("btnSaveMapEdits");
    if (btnSave) {
      btnSave.addEventListener("click", () => this._saveMapEdits());
    }

    const btnCancel = this.shadowRoot.getElementById("btnCancelMapEdits");
    if (btnCancel) {
      btnCancel.addEventListener("click", () => this._cancelMapEdits());
    }

    const svg = this.shadowRoot.getElementById("viewfinderSvg");
    if (!svg) return;

    svg.addEventListener("pointerdown", (e) => {
      if (!this._mapEditMode) return;
      const handle = e.target.closest("[data-handle-type]");
      if (!handle) return;

      const type = handle.dataset.handleType;
      const zone = handle.dataset.zone ? parseInt(handle.dataset.zone, 10) : null;
      const corner = handle.dataset.corner !== undefined ? parseInt(handle.dataset.corner, 10) : null;

      if (type === "zone-select") {
        if (zone) {
          this._selectedZone = zone;
          this._setSelect(this._entities.zone_select, `Zone ${zone}`);
          this._renderZoneCardsAndStepper();
          this._updateViewfinder();
        }
        return;
      }

      handle.setPointerCapture(e.pointerId);
      const svgPt = this._clientToSvg(e);

      const startState = {
        type,
        pointerId: e.pointerId,
        handle,
        startSvgX: svgPt.x,
        startSvgY: svgPt.y,
        zone,
        corner,
        origRoomW: this._formState.roomWidth || 4000,
        origRoomD: this._formState.roomDepth || 5000,
        origOff: this._formState.sensorOffsetX || 0,
        origYaw: this._formState.mountingYaw || 0,
        origCoords: zone && this._zoneEditCoords[zone] ? Object.assign({}, this._zoneEditCoords[zone]) : null
      };

      if (zone) {
        this._selectedZone = zone;
      }

      this._activeDrag = startState;
      e.preventDefault();
      e.stopPropagation();
    });

    svg.addEventListener("pointermove", (e) => {
      if (!this._activeDrag || e.pointerId !== this._activeDrag.pointerId) return;
      const drag = this._activeDrag;
      const svgPt = this._clientToSvg(e);
      const deltaX = svgPt.x - drag.startSvgX;
      const deltaY = svgPt.y - drag.startSvgY;

      const inpW = this.shadowRoot.getElementById("inpRoomWidth");
      const inpD = this.shadowRoot.getElementById("inpRoomDepth");
      const inpOff = this.shadowRoot.getElementById("inpWallOffsetX");
      const inpYaw = this.shadowRoot.getElementById("inpMountingYaw");
      const selPreset = this.shadowRoot.getElementById("selPlacementPreset");

      switch (drag.type) {
        case "wall-right": {
          const newW = Math.max(1000, Math.min(10000, this._snap(drag.origRoomW + deltaX)));
          this._formState.roomWidth = newW;
          if (inpW) inpW.value = newW;
          this._placementDirty = true;
          break;
        }
        case "wall-bottom": {
          const newD = Math.max(1000, Math.min(10000, this._snap(drag.origRoomD + deltaY)));
          this._formState.roomDepth = newD;
          if (inpD) inpD.value = newD;
          this._placementDirty = true;
          break;
        }
        case "corner-room": {
          const newW = Math.max(1000, Math.min(10000, this._snap(drag.origRoomW + deltaX)));
          const newD = Math.max(1000, Math.min(10000, this._snap(drag.origRoomD + deltaY)));
          this._formState.roomWidth = newW;
          this._formState.roomDepth = newD;
          if (inpW) inpW.value = newW;
          if (inpD) inpD.value = newD;
          this._placementDirty = true;
          break;
        }
        case "sensor-move": {
          const rw = this._formState.roomWidth || 4000;
          const maxOff = Math.round(rw / 2);
          const newOff = Math.max(-maxOff, Math.min(maxOff, this._snap(drag.origOff + deltaX)));
          this._formState.sensorOffsetX = newOff;
          this._formState.preset = "custom";
          if (inpOff) inpOff.value = newOff;
          if (selPreset) selPreset.value = "custom";
          this._placementDirty = true;
          break;
        }
        case "sensor-yaw": {
          const rw = this._formState.roomWidth || 4000;
          const sx = (rw / 2) + (this._formState.sensorOffsetX || 0);
          const dx = svgPt.x - sx;
          const dy = svgPt.y;
          const rawDeg = Math.round(Math.atan2(dy, dx) * 180 / Math.PI) - 90;
          const deg = Math.max(-90, Math.min(90, Math.round(rawDeg / 5) * 5));
          this._formState.mountingYaw = deg;
          this._formState.preset = "custom";
          if (inpYaw) inpYaw.value = deg;
          if (selPreset) selPreset.value = "custom";
          this._placementDirty = true;
          break;
        }
        case "zone-body": {
          const z = drag.zone;
          const orig = drag.origCoords;
          if (!z || !orig) break;
          const sDeltaX = this._snap(deltaX);
          const sDeltaY = this._snap(deltaY);
          this._zoneEditCoords[z] = {
            x1: orig.x1 + sDeltaX,
            y1: orig.y1 + sDeltaY,
            x2: orig.x2 + sDeltaX,
            y2: orig.y2 + sDeltaY,
            angle: orig.angle || 0
          };
          this._syncZoneInputsIfSelected(z);
          this._modifiedZones.add(z);
          this._zoneDirty = true;
          break;
        }
        case "zone-corner": {
          const z = drag.zone;
          const orig = drag.origCoords;
          if (!z || !orig) break;
          const rw = this._formState.roomWidth || 4000;
          const sx = (rw / 2) + (this._formState.sensorOffsetX || 0);
          const minX = Math.min(orig.x1, orig.x2);
          const maxX = Math.max(orig.x1, orig.x2);
          const minY = Math.min(orig.y1, orig.y2);
          const maxY = Math.max(orig.y1, orig.y2);
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const csx = sx + cx;
          const csy = cy;

          // Un-rotate delta
          const rad = ((orig.angle || 0) * Math.PI) / 180;
          const dx = svgPt.x - csx;
          const dy = svgPt.y - csy;
          const unrotX = this._snap(dx * Math.cos(-rad) - dy * Math.sin(-rad));
          const unrotY = this._snap(dx * Math.sin(-rad) + dy * Math.cos(-rad));

          let nMinX = minX, nMaxX = maxX, nMinY = minY, nMaxY = maxY;
          if (drag.corner === 0) {
            nMinX = Math.min(maxX - 200, cx + unrotX);
            nMinY = Math.min(maxY - 200, cy + unrotY);
          } else if (drag.corner === 1) {
            nMaxX = Math.max(minX + 200, cx + unrotX);
            nMinY = Math.min(maxY - 200, cy + unrotY);
          } else if (drag.corner === 2) {
            nMaxX = Math.max(minX + 200, cx + unrotX);
            nMaxY = Math.max(minY + 200, cy + unrotY);
          } else if (drag.corner === 3) {
            nMinX = Math.min(maxX - 200, cx + unrotX);
            nMaxY = Math.max(minY + 200, cy + unrotY);
          }

          this._zoneEditCoords[z] = {
            x1: nMinX,
            y1: nMinY,
            x2: nMaxX,
            y2: nMaxY,
            angle: orig.angle || 0
          };
          this._syncZoneInputsIfSelected(z);
          this._modifiedZones.add(z);
          this._zoneDirty = true;
          break;
        }
        case "zone-rotate": {
          const z = drag.zone;
          const orig = drag.origCoords;
          if (!z || !orig) break;
          const rw = this._formState.roomWidth || 4000;
          const sx = (rw / 2) + (this._formState.sensorOffsetX || 0);
          const minX = Math.min(orig.x1, orig.x2);
          const maxX = Math.max(orig.x1, orig.x2);
          const minY = Math.min(orig.y1, orig.y2);
          const maxY = Math.max(orig.y1, orig.y2);
          const csx = sx + (minX + maxX) / 2;
          const csy = (minY + maxY) / 2;

          const dx = svgPt.x - csx;
          const dy = svgPt.y - csy;
          const rawDeg = Math.round(Math.atan2(dy, dx) * 180 / Math.PI) + 90;
          let deg = rawDeg;
          while (deg > 180) deg -= 360;
          while (deg < -180) deg += 360;
          deg = Math.round(deg / 5) * 5;

          this._zoneEditCoords[z] = {
            x1: orig.x1,
            y1: orig.y1,
            x2: orig.x2,
            y2: orig.y2,
            angle: deg
          };
          this._syncZoneInputsIfSelected(z);
          this._modifiedZones.add(z);
          this._zoneDirty = true;
          break;
        }
      }

      this._updateViewfinder();
    });

    const endDrag = (e) => {
      if (this._activeDrag && e.pointerId === this._activeDrag.pointerId) {
        try {
          if (this._activeDrag.handle && this._activeDrag.handle.releasePointerCapture) {
            this._activeDrag.handle.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}
        this._activeDrag = null;
        this._updateViewfinder();
      }
    };

    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
  }

  _renderEditHandles(previewGeom) {
    if (!this._mapEditMode) return "";
    const rw = previewGeom.roomWidth;
    const rd = previewGeom.roomDepth;
    const sx = previewGeom.sx;
    const sy = previewGeom.sy;
    const yaw = previewGeom.angle || 0;

    let hHtml = "";

    // 1. Right Wall Handle
    hHtml += `
      <g class="vf-handle" data-handle-type="wall-right">
        <line x1="${rw}" y1="0" x2="${rw}" y2="${rd}" stroke="#38bdf8" stroke-width="26" opacity="0.45" stroke-dasharray="40,25" class="vf-handle vf-handle-wall" data-handle-type="wall-right" />
        <g transform="translate(${rw}, ${rd / 2})" class="vf-handle vf-handle-wall" data-handle-type="wall-right">
          <rect x="-45" y="-90" width="90" height="180" rx="45" fill="#38bdf8" stroke="#0f172a" stroke-width="12" />
          <text x="0" y="22" fill="#0f172a" font-size="95" font-weight="900" text-anchor="middle" pointer-events="none">↔</text>
        </g>
      </g>
    `;

    // 2. Bottom Wall Handle
    hHtml += `
      <g class="vf-handle" data-handle-type="wall-bottom">
        <line x1="0" y1="${rd}" x2="${rw}" y2="${rd}" stroke="#38bdf8" stroke-width="26" opacity="0.45" stroke-dasharray="40,25" class="vf-handle vf-handle-wall-ns" data-handle-type="wall-bottom" />
        <g transform="translate(${rw / 2}, ${rd})" class="vf-handle vf-handle-wall-ns" data-handle-type="wall-bottom">
          <rect x="-90" y="-45" width="180" height="90" rx="45" fill="#38bdf8" stroke="#0f172a" stroke-width="12" />
          <text x="0" y="28" fill="#0f172a" font-size="95" font-weight="900" text-anchor="middle" pointer-events="none">↕</text>
        </g>
      </g>
    `;

    // 3. Corner Handle
    hHtml += `
      <g class="vf-handle vf-handle-corner" data-handle-type="corner-room" transform="translate(${rw}, ${rd})">
        <circle cx="0" cy="0" r="75" fill="#38bdf8" stroke="#0f172a" stroke-width="14" />
        <text x="0" y="24" fill="#0f172a" font-size="85" font-weight="900" text-anchor="middle" pointer-events="none">⤡</text>
      </g>
    `;

    // 4. Sensor Slide Halo & Yaw Handle
    hHtml += `
      <g class="vf-handle vf-handle-sensor" data-handle-type="sensor-move">
        <circle cx="${sx}" cy="${sy}" r="180" fill="rgba(56, 189, 248, 0.2)" stroke="#38bdf8" stroke-width="16" stroke-dasharray="30,20" class="vf-handle vf-handle-sensor" data-handle-type="sensor-move" />
        <text x="${sx}" y="${sy + 260}" fill="#38bdf8" font-size="110" font-weight="800" text-anchor="middle" pointer-events="none">↔ SLIDE</text>
      </g>
    `;

    const rad = ((yaw + 90) * Math.PI) / 180;
    const hx = sx + 900 * Math.cos(rad);
    const hy = sy + 900 * Math.sin(rad);
    hHtml += `
      <g class="vf-handle">
        <line x1="${sx}" y1="${sy}" x2="${hx}" y2="${hy}" stroke="#f59e0b" stroke-width="14" stroke-dasharray="25,15" pointer-events="none" />
        <g class="vf-handle vf-handle-yaw" data-handle-type="sensor-yaw" transform="translate(${hx}, ${hy})">
          <circle cx="0" cy="0" r="75" fill="#f59e0b" stroke="#0f172a" stroke-width="14" />
          <text x="0" y="24" fill="#0f172a" font-size="85" font-weight="900" text-anchor="middle" pointer-events="none">↻</text>
        </g>
      </g>
    `;

    // 5. Zone Handles for Selected Zone
    const ent = this._entities;
    const stableHass = radarStableHass(this._hass);
    const activeZonesList = RadarEntityResolver.getActiveZones(stableHass, ent, this._locallyEnabledZones);

    for (const z of activeZonesList) {
      const isSel = z === this._selectedZone;
      let c = this._zoneEditCoords[z];
      if (!c) {
        const states = stableHass.states;
        const getV = (id, def = 0) => {
          if (!id || !states[id]) return def;
          const v = parseFloat(states[id].state);
          return Number.isFinite(v) ? v : def;
        };
        c = {
          x1: getV(ent[`zone${z}_x1`]),
          y1: getV(ent[`zone${z}_y1`]),
          x2: getV(ent[`zone${z}_x2`]),
          y2: getV(ent[`zone${z}_y2`]),
          angle: getV(ent[`zone${z}_angle`], 0)
        };
      }

      if (c.x1 === 0 && c.x2 === 0 && c.y1 === 0 && c.y2 === 0) continue;
      const corners = RoomGeometry.transformZonePolygon(c.x1, c.y1, c.x2, c.y2, c.angle || 0, previewGeom);
      const pts = corners.map(p => `${p.x},${p.y}`).join(" ");

      if (!isSel) {
        hHtml += `
          <polygon points="${pts}" fill="rgba(255, 255, 255, 0.01)" stroke="#38bdf8" stroke-width="8" stroke-dasharray="20,15" class="vf-handle" data-handle-type="zone-select" data-zone="${z}" style="cursor:pointer;" />
        `;
      } else {
        hHtml += `
          <polygon points="${pts}" fill="rgba(245, 158, 11, 0.15)" stroke="#f59e0b" stroke-width="14" class="vf-handle vf-handle-zone-body" data-handle-type="zone-body" data-zone="${z}" />
        `;

        for (let i = 0; i < 4; i++) {
          hHtml += `
            <circle cx="${corners[i].x}" cy="${corners[i].y}" r="65" fill="#f59e0b" stroke="#fff" stroke-width="12" class="vf-handle vf-handle-zone-corner" data-handle-type="zone-corner" data-zone="${z}" data-corner="${i}" />
          `;
        }

        const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
        const normAngle = ((c.angle || 0) - 90) * Math.PI / 180;
        const rx = topMid.x + 280 * Math.cos(normAngle);
        const ry = topMid.y + 280 * Math.sin(normAngle);
        hHtml += `
          <line x1="${topMid.x}" y1="${topMid.y}" x2="${rx}" y2="${ry}" stroke="#f59e0b" stroke-width="12" stroke-dasharray="20,15" pointer-events="none" />
          <g class="vf-handle vf-handle-zone-rotate" data-handle-type="zone-rotate" data-zone="${z}" transform="translate(${rx}, ${ry})">
            <circle cx="0" cy="0" r="60" fill="#f59e0b" stroke="#0f172a" stroke-width="12" />
            <text x="0" y="20" fill="#0f172a" font-size="70" font-weight="900" text-anchor="middle" pointer-events="none">↻</text>
          </g>
        `;
      }
    }

    return hHtml;
  }

  _renderHud() {
    if (!this._activeDrag) return "";
    const drag = this._activeDrag;
    let text = "";
    let hx = 0, hy = 0;

    if (drag.type.startsWith("wall-") || drag.type === "corner-room") {
      const rw = this._formState.roomWidth || 4000;
      const rd = this._formState.roomDepth || 5000;
      text = `Room: ${Math.round(rw)} × ${Math.round(rd)} mm`;
      hx = rw / 2;
      hy = rd / 2;
    } else if (drag.type === "sensor-move" || drag.type === "sensor-yaw") {
      const rw = this._formState.roomWidth || 4000;
      const off = this._formState.sensorOffsetX || 0;
      const yaw = this._formState.mountingYaw || 0;
      text = `Offset X: ${Math.round(off)} mm | Yaw: ${Math.round(yaw)}°`;
      hx = (rw / 2) + off;
      hy = 350;
    } else if (drag.type.startsWith("zone-")) {
      const z = drag.zone;
      const c = this._zoneEditCoords[z];
      if (c) {
        const w = Math.abs(c.x2 - c.x1);
        const d = Math.abs(c.y2 - c.y1);
        text = `Zone ${z}: ${Math.round(w)} × ${Math.round(d)} mm (Angle: ${c.angle || 0}°)`;
        const rw = this._formState.roomWidth || 4000;
        const sx = (rw / 2) + (this._formState.sensorOffsetX || 0);
        hx = sx + (c.x1 + c.x2) / 2;
        hy = Math.max(200, (c.y1 + c.y2) / 2 - 200);
      }
    }

    if (!text) return "";
    const boxW = Math.max(600, text.length * 42);
    return `
      <g pointer-events="none">
        <rect x="${hx - boxW / 2}" y="${hy - 65}" width="${boxW}" height="120" rx="20" fill="rgba(15, 23, 42, 0.95)" stroke="#38bdf8" stroke-width="10" />
        <text x="${hx}" y="${hy + 15}" fill="#38bdf8" font-size="95" font-weight="900" text-anchor="middle" dominant-baseline="middle">${text}</text>
      </g>
    `;
  }

  _bindEvents() {
    const selDevice = this.shadowRoot.getElementById("activeDeviceSelect");
    if (selDevice) {
      selDevice.addEventListener("change", (e) => {
        if (e.target.value === "__new__") {
          e.target.value = this._selectedDevice;
          RadarSetupWizard.open(this.shadowRoot, "calWz");
          return;
        }
        this._switchDevice(e.target.value, true);
        this._showToast(`Switched to ${e.target.options[e.target.selectedIndex].text}`);
        this._renderZoneCardsAndStepper();
      });
    }

    const btnRestart = this.shadowRoot.getElementById("btnRestartSensor");
    if (btnRestart) {
      btnRestart.addEventListener("click", () => {
        if (confirm("Restart ESP32 Presence Sensor?")) {
          this._pressButton(this._entities.restart_esp);
          this._showToast("Restart command sent to ESP32 node.");
        }
      });
    }

    const calChipsBar = this.shadowRoot.getElementById("calChipsBar");
    if (calChipsBar) {
      calChipsBar.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        const entityId = chip.dataset?.entity || chip.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }

    const vfZones = this.shadowRoot.getElementById("vfZonesLayer");
    if (vfZones) {
      vfZones.addEventListener("click", (e) => {
        const grp = e.target.closest(".vf-zone-group");
        if (!grp) return;
        const entityId = grp.dataset?.entity || grp.getAttribute("data-entity");
        if (entityId) this._openMoreInfo(entityId);
      });
    }

    this.shadowRoot.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        this._activeTab = tab;
        this.shadowRoot.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
        this.shadowRoot.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`));
        if (tab === "placement") {
          this._updateViewfinder();
        } else if (tab === "zones") {
          this._renderZoneCardsAndStepper();
        }
      });
    });

    // Zones tab: delegated listeners bound ONCE (the inner markup can be re-rendered freely)
    const zonesToolbar = this.shadowRoot.getElementById("zonesToolbar");
    if (zonesToolbar) {
      zonesToolbar.addEventListener("click", (e) => {
        const btn = e.target.closest("#btnAddZoneTop");
        if (!btn || btn.disabled) return;
        this._addNextZone();
      });
    }
    const zonesGrid = this.shadowRoot.getElementById("zonesCardsGrid");
    if (zonesGrid) {
      zonesGrid.addEventListener("click", (e) => {
        const addFirst = e.target.closest("#btnAddFirstZone");
        if (addFirst) {
          if (!addFirst.disabled) this._addNextZone();
          return;
        }
        const dis = e.target.closest(".btn-zone-disable");
        if (dis) {
          e.stopPropagation();
          if (!dis.disabled) this._disableZone(parseInt(dis.dataset.zone, 10));
          return;
        }
        const card = e.target.closest(".zone-card");
        if (card) {
          this._selectedZone = parseInt(card.dataset.zone, 10);
          this._zoneDirty = false;
          this._setSelect(this._entities.zone_select, `Zone ${this._selectedZone}`);
          this._renderZoneCardsAndStepper();
          this._updateViewfinder();
        }
      });
    }

    // Tab 1: remember unsaved edits so live ESP32 updates don't overwrite them
    const panePlacement = this.shadowRoot.getElementById("tabPlacement");
    if (panePlacement) {
      const placementIds = ["selPlacementPreset", "inpRoomWidth", "inpRoomDepth", "inpWallOffsetX", "inpMountingYaw"];
      ["input", "change"].forEach(evt => panePlacement.addEventListener(evt, (e) => {
        if (e.target && placementIds.includes(e.target.id)) this._placementDirty = true;
      }));
    }

    // Placement Preset change: immediately updates formState and redraws SVG viewfinder!
    const selPreset = this.shadowRoot.getElementById("selPlacementPreset");
    const inpOff = this.shadowRoot.getElementById("inpWallOffsetX");
    const inpYaw = this.shadowRoot.getElementById("inpMountingYaw");
    const inpW = this.shadowRoot.getElementById("inpRoomWidth");
    const inpD = this.shadowRoot.getElementById("inpRoomDepth");

    if (selPreset) {
      const handlePresetChange = (e) => {
        const p = e.target.value;
        this._formState.preset = p;
        const rw = this._formState.roomWidth || 4000;

        switch (p) {
          case "corner_45_left":
            this._formState.sensorOffsetX = -Math.round(rw / 2);
            this._formState.mountingYaw = -45;
            break;
          case "corner_45_right":
            this._formState.sensorOffsetX = Math.round(rw / 2);
            this._formState.mountingYaw = 45;
            break;
          case "left_corner":
            this._formState.sensorOffsetX = -Math.round(rw / 2);
            this._formState.mountingYaw = 0;
            break;
          case "right_corner":
            this._formState.sensorOffsetX = Math.round(rw / 2);
            this._formState.mountingYaw = 0;
            break;
          case "center":
            this._formState.sensorOffsetX = 0;
            this._formState.mountingYaw = 0;
            break;
          case "custom":
          default:
            break;
        }

        if (inpOff) inpOff.value = this._formState.sensorOffsetX;
        if (inpYaw) inpYaw.value = this._formState.mountingYaw;

        // Immediately update SVG graphics!
        this._updateViewfinder();
      };

      selPreset.addEventListener("change", handlePresetChange);
      selPreset.addEventListener("input", handlePresetChange);
    }

    // Input changes: update formState and update SVG viewfinder live!
    if (inpW) {
      inpW.addEventListener("input", () => {
        this._formState.roomWidth = Math.max(500, parseFloat(inpW.value) || 4000);
        // If on an aligned preset, adjust offset
        if (this._formState.preset === "corner_45_left" || this._formState.preset === "left_corner") {
          this._formState.sensorOffsetX = -Math.round(this._formState.roomWidth / 2);
          if (inpOff) inpOff.value = this._formState.sensorOffsetX;
        } else if (this._formState.preset === "corner_45_right" || this._formState.preset === "right_corner") {
          this._formState.sensorOffsetX = Math.round(this._formState.roomWidth / 2);
          if (inpOff) inpOff.value = this._formState.sensorOffsetX;
        }
        this._updateViewfinder();
      });
    }

    if (inpD) {
      inpD.addEventListener("input", () => {
        this._formState.roomDepth = Math.max(500, parseFloat(inpD.value) || 5000);
        this._updateViewfinder();
      });
    }

    if (inpOff) {
      inpOff.addEventListener("input", () => {
        const v = parseFloat(inpOff.value);
        if (!isNaN(v)) {
          this._formState.sensorOffsetX = v;
        }
        this._formState.preset = "custom";
        if (selPreset) selPreset.value = "custom";
        this._updateViewfinder();
      });
    }

    if (inpYaw) {
      inpYaw.addEventListener("input", () => {
        const v = parseFloat(inpYaw.value);
        if (!isNaN(v)) {
          this._formState.mountingYaw = v;
        }
        this._formState.preset = "custom";
        if (selPreset) selPreset.value = "custom";
        this._updateViewfinder();
      });
    }

    const chkInvX = this.shadowRoot.getElementById("chkInvertX");
    if (chkInvX) {
      chkInvX.addEventListener("change", () => {
        this._formState.invertX = Boolean(chkInvX.checked);
        const entId = this._entities.invert_x_switch;
        if (entId && this._hass && this._hass.states[entId]) {
          this._callService("switch", this._formState.invertX ? "turn_on" : "turn_off", { entity_id: entId });
        }
        this._showToast(this._formState.invertX ? "Upside-down X-axis flip enabled." : "Standard upright X-axis restored.");
        this._updateViewfinder();
      });
    }

    // Save & Flash to ESP32
    const btnFlash = this.shadowRoot.getElementById("btnSaveRoomFlash");
    if (btnFlash) {
      btnFlash.addEventListener("click", () => {
        this._placementDirty = false;
        const rw = this._formState.roomWidth || 4000;
        const rd = this._formState.roomDepth || 5000;
        const off = this._formState.sensorOffsetX || 0;
        const yaw = this._formState.mountingYaw || 0;

        if (this._entities.room_width) this._setNumber(this._entities.room_width, rw);
        if (this._entities.room_depth) this._setNumber(this._entities.room_depth, rd);
        if (this._entities.sensor_wall_offset_x) this._setNumber(this._entities.sensor_wall_offset_x, off);
        if (this._entities.mounting_angle) this._setNumber(this._entities.mounting_angle, yaw);

        setTimeout(() => {
          if (this._entities.apply_room_dimensions_btn && this._hass && this._hass.states[this._entities.apply_room_dimensions_btn]) {
            this._pressButton(this._entities.apply_room_dimensions_btn);
          } else {
            const minX = -(rw * 0.5 + off);
            const maxX = +(rw * 0.5 - off);
            if (this._entities.room_min_x) this._setNumber(this._entities.room_min_x, minX);
            if (this._entities.room_max_x) this._setNumber(this._entities.room_max_x, maxX);
            if (this._entities.room_min_y) this._setNumber(this._entities.room_min_y, 0);
            if (this._entities.room_max_y) this._setNumber(this._entities.room_max_y, rd);
          }
          this._showToast("⚡ Room boundaries successfully flashed to ESP32!");
        }, 300);
      });
    }

    const btnReset = this.shadowRoot.getElementById("btnResetRoomBounds");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        this._placementDirty = false;
        this._formState.preset = "center";
        this._formState.sensorOffsetX = 0;
        this._formState.mountingYaw = 0;
        this._formState.roomWidth = 6000;
        this._formState.roomDepth = 6000;

        if (selPreset) selPreset.value = "center";
        if (inpW) inpW.value = 6000;
        if (inpD) inpD.value = 6000;
        if (inpOff) inpOff.value = 0;
        if (inpYaw) inpYaw.value = 0;

        this._updateViewfinder();

        if (this._entities.room_width) this._setNumber(this._entities.room_width, 6000);
        if (this._entities.room_depth) this._setNumber(this._entities.room_depth, 6000);
        if (this._entities.sensor_wall_offset_x) this._setNumber(this._entities.sensor_wall_offset_x, 0);
        if (this._entities.mounting_angle) this._setNumber(this._entities.mounting_angle, 0);
        if (this._entities.room_min_x) this._setNumber(this._entities.room_min_x, -3000);
        if (this._entities.room_max_x) this._setNumber(this._entities.room_max_x, 3000);
        if (this._entities.room_min_y) this._setNumber(this._entities.room_min_y, 0);
        if (this._entities.room_max_y) this._setNumber(this._entities.room_max_y, 6000);
        this._showToast("Boundaries reset to default 6000 × 6000 mm radar range.");
      });
    }

    // Engine Tab Event Handlers
    const bindNumSave = (btnId, inputId, entityKey, toastText) => {
      const b = this.shadowRoot.getElementById(btnId);
      if (b) {
        b.addEventListener("click", () => {
          const val = parseFloat(this.shadowRoot.getElementById(inputId).value);
          if (!isNaN(val)) {
            this._setNumber(this._entities[entityKey], val);
            this._showToast(toastText);
          }
        });
      }
    };
    bindNumSave("btnSaveMaxDist", "inpMaxDistance", "max_distance", "Max distance updated.");
    bindNumSave("btnSaveTimeout", "inpPresenceTimeout", "presence_timeout", "Presence timeout updated.");
    bindNumSave("btnSaveZoneDelay", "inpZoneOffDelay", "zone_off_delay", "Zone off delay updated.");
    bindNumSave("btnSaveStatTimeout", "inpStationaryTimeout", "stationary_latch_timeout", "Stationary latch timeout updated.");
    bindNumSave("btnSaveExitMargin", "inpExitMargin", "exit_trajectory_margin", "Exit trajectory margin updated.");

    const chkStat = this.shadowRoot.getElementById("chkStationaryMemory");
    if (chkStat) {
      chkStat.addEventListener("change", () => {
        this._toggleSwitch(this._entities.stationary_memory_switch);
        this._showToast("Stationary memory toggled.");
      });
    }

    const chkMulti = this.shadowRoot.getElementById("chkMultiTarget");
    if (chkMulti) {
      chkMulti.addEventListener("change", () => {
        this._toggleSwitch(this._entities.multi_target);
        this._showToast("Multi-target tracking toggled.");
      });
    }

    const btnRestRad = this.shadowRoot.getElementById("btnRestartRadarChip");
    if (btnRestRad) {
      btnRestRad.addEventListener("click", () => {
        this._pressButton(this._entities.restart_radar);
        this._showToast("Radar module restart command sent.");
      });
    }

    const btnResetRad = this.shadowRoot.getElementById("btnFactoryResetRadar");
    if (btnResetRad) {
      btnResetRad.addEventListener("click", () => {
        if (confirm("Reset LD2450 radar chip to factory settings?")) {
          this._pressButton(this._entities.factory_reset_radar);
          this._showToast("Factory reset command sent.");
        }
      });
    }

    this._bindMapEditEvents();
  }

  // Updates the SVG Viewfinder graphics instantly based on current formState!
  _updateViewfinder() {
    if (!this.shadowRoot) return;

    const rw = Math.max(1000, this._formState.roomWidth || 4000);
    const rd = Math.max(1000, this._formState.roomDepth || 5000);
    const off = this._formState.sensorOffsetX || 0;
    const yaw = this._formState.mountingYaw || 0;

    // Sensor position along the front wall: center is rw / 2, plus offset
    const sx = (rw / 2) + off;
    const sy = 0;

    const previewGeom = {
      hasRoom: true,
      roomWidth: rw,
      roomDepth: rd,
      sx: sx,
      sy: sy,
      angle: yaw,
      sensorOffsetX: off,
      invertX: Boolean(this._formState.invertX)
    };

    // 1. Update SVG ViewBox & Clip
    const svg = this.shadowRoot.getElementById("viewfinderSvg");
    if (svg) {
      const margin = 500;
      const minVbX = Math.min(0, sx) - margin;
      const maxVbX = Math.max(rw, sx) + margin;
      svg.setAttribute("viewBox", `${minVbX} ${-margin} ${maxVbX - minVbX} ${rd + margin * 2}`);
      const vfClipRect = this.shadowRoot.getElementById("vfRoomClipRect");
      if (vfClipRect) {
        vfClipRect.setAttribute("width", rw);
        vfClipRect.setAttribute("height", rd);
      }
    }

    // 1b. Update Floorplan Layer
    const calFp = RadarFloorplanManager.getFloorplan(this._config, this._selectedDevice);
    const vfFpLayer = this.shadowRoot.getElementById("vfFloorplanLayer");
    if (vfFpLayer) {
      radarSetHtml(vfFpLayer, RadarFloorplanManager.renderFloorplanSvg(calFp, previewGeom, "vfRoomClip"));
    }

    // 2. Update Room Walls
    const vfRoom = this.shadowRoot.getElementById("vfRoomLayer");
    if (vfRoom) {
      const hasFp = Boolean(calFp && calFp.image);
      const vfRoomFill = hasFp ? "none" : "rgba(15, 23, 42, 0.6)";
      radarSetHtml(vfRoom, `
        <rect x="0" y="0" width="${rw}" height="${rd}"
              fill="${vfRoomFill}" stroke="#38bdf8" stroke-width="8" rx="6" />
        <text x="${rw / 2}" y="-120" fill="#94a3b8" font-size="160" font-weight="700" text-anchor="middle">
          ${Math.round(rw)} mm
        </text>
        <text x="-120" y="${rd / 2}" fill="#94a3b8" font-size="160" font-weight="700" text-anchor="middle"
              transform="rotate(-90, -120, ${rd / 2})">
          ${Math.round(rd)} mm
        </text>
      `);
    }

    // 3. Update Sensor Icon & Angled Beam Cone
    const vfBeamCone = this.shadowRoot.getElementById("vfBeamCone");
    const vfSensor = this.shadowRoot.getElementById("vfSensorLayer");
    if (vfBeamCone && vfSensor) {
      radarSetHtml(vfSensor, `
        <circle cx="${sx}" cy="${sy}" r="120" fill="#0284c7" stroke="#38bdf8" stroke-width="12" />
        <circle cx="${sx}" cy="${sy}" r="40" fill="#fff" />
      `);

      const beamDist = Math.max(rw, rd) * 1.3;
      const radCenter = (((yaw || 0) + 90) * Math.PI) / 180;
      const fovRad = (60 * Math.PI) / 180;
      const lx = sx + beamDist * Math.cos(radCenter - fovRad);
      const ly = sy + beamDist * Math.sin(radCenter - fovRad);
      const rx = sx + beamDist * Math.cos(radCenter + fovRad);
      const ry = sy + beamDist * Math.sin(radCenter + fovRad);

      vfBeamCone.setAttribute("d", `M ${sx} ${sy} L ${lx} ${ly} A ${beamDist} ${beamDist} 0 0 1 ${rx} ${ry} Z`);
    }

    // 4. Update Zones inside Viewfinder
    const vfZones = this.shadowRoot.getElementById("vfZonesLayer");
    if (vfZones && this._entities && this._hass) {
      const ent = this._entities;
      const stableHass = radarStableHass(this._hass);
      const states = stableHass.states;
      const getVal = (id, def = 0) => {
        if (!id || !states[id]) return def;
        const v = parseFloat(states[id].state);
        return Number.isFinite(v) ? v : def;
      };
      const getState = (id, def = "off") => (id && states[id]) ? states[id].state : def;

      const activeZonesList = RadarEntityResolver.getActiveZones(stableHass, ent, this._locallyEnabledZones);
      let zHtml = "";
      for (const z of activeZonesList) {
        let x1 = getVal(ent[`zone${z}_x1`]);
        let y1 = getVal(ent[`zone${z}_y1`]);
        let x2 = getVal(ent[`zone${z}_x2`]);
        let y2 = getVal(ent[`zone${z}_y2`]);
        let zAngle = getVal(ent[`zone${z}_angle`], 0);
        const zOcc = getState(ent[`zone${z}_occupancy`]) === "on";
        const isExcl = getState(ent[`zone${z}_mode`]) === "Exclusion";

        if (this._zoneEditCoords && this._zoneEditCoords[z]) {
          x1 = this._zoneEditCoords[z].x1;
          y1 = this._zoneEditCoords[z].y1;
          x2 = this._zoneEditCoords[z].x2;
          y2 = this._zoneEditCoords[z].y2;
          zAngle = this._zoneEditCoords[z].angle || 0;
        } else if (z === this._selectedZone && this._zoneDirty) {
          const inX1 = this.shadowRoot.getElementById("inpZone_x1");
          const inY1 = this.shadowRoot.getElementById("inpZone_y1");
          const inX2 = this.shadowRoot.getElementById("inpZone_x2");
          const inY2 = this.shadowRoot.getElementById("inpZone_y2");
          const inAng = this.shadowRoot.getElementById("inpZone_angle");
          if (inX1 && inY1 && inX2 && inY2) {
            const vx1 = parseFloat(inX1.value);
            const vy1 = parseFloat(inY1.value);
            const vx2 = parseFloat(inX2.value);
            const vy2 = parseFloat(inY2.value);
            const va = inAng ? parseFloat(inAng.value) : 0;
            if (!isNaN(vx1)) x1 = vx1;
            if (!isNaN(vy1)) y1 = vy1;
            if (!isNaN(vx2)) x2 = vx2;
            if (!isNaN(vy2)) y2 = vy2;
            if (!isNaN(va)) zAngle = va;
          }
        }

        if (x1 !== 0 || x2 !== 0 || y1 !== 0 || y2 !== 0) {
          const corners = RoomGeometry.transformZonePolygon(x1, y1, x2, y2, zAngle, previewGeom);
          const pts = corners.map(p => `${p.x},${p.y}`).join(" ");
          const zEntity = ent[`zone${z}_occupancy`] || "";

          if (isExcl) {
            const stroke = z === this._selectedZone ? "#f59e0b" : (zOcc ? "#ef4444" : "#f87171");
            const fill = z === this._selectedZone ? "rgba(245, 158, 11, 0.2)" : (zOcc ? "rgba(239, 68, 68, 0.35)" : "url(#vfExclusionHatch)");
            zHtml += `
              <g class="vf-zone-group exclusion" data-zone="${z}" data-entity="${zEntity}">
                <title>${zEntity ? `Zone ${z} (Mask) - Click to view history (${zEntity})` : `Zone ${z} (Mask)`}</title>
                <polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${z === this._selectedZone ? 16 : 10}" stroke-dasharray="25,15" />
                <text x="${(corners[0].x + corners[2].x) / 2}" y="${(corners[0].y + corners[2].y) / 2}" fill="${stroke}"
                      font-size="140" font-weight="700" text-anchor="middle" dominant-baseline="middle">
                  Zone ${z} (Mask)${zOcc ? " ⚠️" : ""}
                </text>
              </g>
            `;
          } else {
            const stroke = z === this._selectedZone ? "#f59e0b" : (zOcc ? "#10b981" : "#38bdf8");
            const fill = z === this._selectedZone ? "rgba(245, 158, 11, 0.2)" : (zOcc ? "rgba(16, 185, 129, 0.2)" : "rgba(56, 189, 248, 0.08)");
            zHtml += `
              <g class="vf-zone-group" data-zone="${z}" data-entity="${zEntity}">
                <title>${zEntity ? `Zone ${z} - Click to view history (${zEntity})` : `Zone ${z}`}</title>
                <polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${z === this._selectedZone ? 16 : 10}" />
                <text x="${(corners[0].x + corners[2].x) / 2}" y="${(corners[0].y + corners[2].y) / 2}" fill="${stroke}"
                      font-size="140" font-weight="700" text-anchor="middle" dominant-baseline="middle">
                  Zone ${z}${zOcc ? " 👤" : ""}
                </text>
              </g>
            `;
          }
        }
      }
      radarSetHtml(vfZones, zHtml);
    }

    const vfMasks = this.shadowRoot.getElementById("vfMasksLayer");
    radarSetHtml(vfMasks, "");

    // 5. Update Targets
    this._updateVfTargets(previewGeom);

    // 6. Interactive Map Edit Handles & Live HUD
    const vfHandles = this.shadowRoot.getElementById("vfEditHandlesLayer");
    if (vfHandles) {
      radarSetHtml(vfHandles, this._renderEditHandles(previewGeom));
    }
    const vfHud = this.shadowRoot.getElementById("vfHudLayer");
    if (vfHud) {
      radarSetHtml(vfHud, this._renderHud());
    }
  }

  // Live targets projected using current preview geometry
  _updateVfTargets(previewGeom) {
    const vfTargets = this.shadowRoot.getElementById("vfTargetsLayer");
    if (!vfTargets || !this._entities || !this._hass) return;

    const ent = this._entities;
    const states = this._hass.states;

    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };

    let tHtml = "";
    for (let t = 1; t <= 3; t++) {
      const tx = getVal(ent[`target${t}_x`], NaN);
      const ty = getVal(ent[`target${t}_y`], NaN);
      const dist = getVal(ent[`target${t}_distance`], 0);

      if (Number.isFinite(tx) && Number.isFinite(ty) && dist > 0) {
        const pt = RoomGeometry.transformPoint(tx, ty, previewGeom);
        const color = t === 1 ? "#38bdf8" : (t === 2 ? "#a855f7" : "#f59e0b");

        tHtml += `
          <circle cx="${pt.x}" cy="${pt.y}" r="120" fill="${color}" opacity="0.3" />
          <circle cx="${pt.x}" cy="${pt.y}" r="70" fill="${color}" stroke="#fff" stroke-width="14" />
          <text x="${pt.x}" y="${pt.y - 100}" fill="#fff" font-size="130" font-weight="800" text-anchor="middle">
            T${t} (${Math.round(dist)}mm)
          </text>
        `;
      }
    }
    radarSetHtml(vfTargets, tHtml);
  }

  // Signature of this device's entity states + local UI state. Unrelated hass updates are ignored.
  _computeLiveSig() {
    const ent = this._entities || {};
    if (!this._watchIds) {
      this._watchIds = Object.values(ent).filter(v => typeof v === "string" && v.indexOf(".") > 0);
    }
    const states = this._hass.states;
    let sig = [
      RadarEntityResolver._registryVersion, this._activeTab, this._selectedZone,
      this._zonePending ? 1 : 0, this._mapEditMode ? 1 : 0, Array.from(this._locallyEnabledZones || []).join(",")
    ].join("|") + "|";
    for (const id of this._watchIds) {
      const s = states[id];
      sig += (s ? s.state : "-") + "|";
    }
    return sig;
  }

  // Only updates live status badges & live telemetry - NEVER overwrites active user typing!
  _updateLiveValues() {
    if (!this._hass || !this.shadowRoot) return;
    if (!this._entities) {
      this._entities = RadarEntityResolver.resolve(this._hass, { device: this._selectedDevice });
    }

    // If device switched, re-init formState
    if (this._formState.device !== this._selectedDevice) {
      this._initFormStateFromEntities();
      this._lastLiveSig = null;
    }

    const sig = this._computeLiveSig();
    if (sig === this._lastLiveSig) return;
    this._lastLiveSig = sig;

    const ent = this._entities;
    const states = this._hass.states;
    const stableHass = radarStableHass(this._hass);
    RadarUpdateManager.updateBanner(this.shadowRoot, "calUpd", stableHass, ent, this._selectedDevice, this);

    // Pick up room geometry changes from the ESP32 (or values that arrived after a reconnect)
    if (!this._mapEditMode && !this._placementDirty && this._roomSig() !== this._lastRoomSig) {
      this._syncPlacementFromEntities();
    }

    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };
    const getState = (id, def = "off") => (id && states[id]) ? states[id].state : def;
    const t1State = states[ent.target1_x];
    const isOffline = !t1State || t1State.state === "unavailable";

    // Header Chips
    const occ = getState(ent.occupancy, "off") === "on";
    const chipOcc = this.shadowRoot.getElementById("chipCalOcc");
    if (chipOcc) {
      chipOcc.className = "chip " + (occ ? "occupied" : "");
      chipOcc.textContent = occ ? "🟢 Occupied" : "⚪ Clear";
      chipOcc.dataset.entity = ent.occupancy || "";
      chipOcc.title = ent.occupancy ? `Click to view history (${ent.occupancy})` : "Occupancy";
    }

    const tc = getVal(ent.target_count, 0);
    const chipTc = this.shadowRoot.getElementById("chipCalTargets");
    if (chipTc) {
      chipTc.textContent = `🎯 ${tc} Target${tc === 1 ? "" : "s"}`;
      chipTc.dataset.entity = ent.target_count || "";
      chipTc.title = ent.target_count ? `Click to view history (${ent.target_count})` : "Target Count";
    }

    const latched = getState(ent.stationary_memory_active, "off") === "on";
    const chipLatch = this.shadowRoot.getElementById("chipCalLatch");
    if (chipLatch) {
      chipLatch.style.display = latched ? "inline-flex" : "none";
      chipLatch.className = "chip latched";
      chipLatch.dataset.entity = ent.stationary_memory_active || "";
      chipLatch.title = ent.stationary_memory_active ? `Click to view history (${ent.stationary_memory_active})` : "Stationary Latch";
    }

    const wifi = states[ent.wifi_signal] ? states[ent.wifi_signal].state : "--";
    const chipWifi = this.shadowRoot.getElementById("chipCalWifi");
    if (chipWifi) {
      chipWifi.textContent = isOffline ? "⏳ Reconnecting…" : `📶 ${wifi} dBm`;
      chipWifi.dataset.entity = ent.wifi_signal || "";
      chipWifi.title = ent.wifi_signal ? `Click to view history (${ent.wifi_signal})` : "Wi-Fi Signal";
    }

    // Viewfinder is visible on ALL tabs: refresh zones (occupancy colours, captures) + targets.
    // DOM is only touched when the generated markup changes.
    this._updateViewfinder();

    if (this._activeTab === "zones") {
      this._renderZoneCardsAndStepper();
    }
  }

  _addNextZone() {
    if (this._zonePending || !this._entities || !this._hass) return;
    const activeList = RadarEntityResolver.getActiveZones(radarStableHass(this._hass), this._entities, this._locallyEnabledZones);
    const nextZ = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find(n => !activeList.includes(n));
    if (nextZ) this._enableZone(nextZ);
  }

  async _enableZone(z) {
    if (this._zonePending || !this._entities || !this._hass) return;
    this._zonePending = true;
    this._renderZoneCardsAndStepper();
    try {
      const res = await RadarVisibilityManager.enableZone(this._hass, this._entities, z);
      if (res.reason === "admin") {
        this._showToast("⚠️ Only Home Assistant administrators can enable zone entities.");
        return;
      }
      if (!res.okCount) {
        this._showToast(`⚠️ Could not enable Zone ${z} entities in Home Assistant (see browser console).`);
        return;
      }
      if (!this._locallyEnabledZones) this._locallyEnabledZones = new Set();
      this._locallyEnabledZones.add(z);
      this._selectedZone = z;
      this._setSelect(this._entities.zone_select, `Zone ${z}`);

      // Calculate room-central default coordinates (box centered in room space)
      const rw = this._formState.roomWidth || 4000;
      const rd = this._formState.roomDepth || 5000;
      const off = this._formState.sensorOffsetX || 0;

      // Default box: 1200 mm wide x 1000 mm deep centered in room
      const boxW = Math.min(1400, Math.max(800, Math.round(rw * 0.35)));
      const boxD = Math.min(1200, Math.max(800, Math.round(rd * 0.25)));
      const sensorCenterX = -off;
      const sensorCenterY = Math.max(boxD / 2 + 200, Math.round(rd * 0.45));

      const defX1 = Math.round((sensorCenterX - boxW / 2) / 50) * 50;
      const defX2 = Math.round((sensorCenterX + boxW / 2) / 50) * 50;
      const defY1 = Math.round((sensorCenterY - boxD / 2) / 50) * 50;
      const defY2 = Math.round((sensorCenterY + boxD / 2) / 50) * 50;

      this._zoneEditCoords[z] = {
        x1: defX1,
        y1: defY1,
        x2: defX2,
        y2: defY2,
        angle: 0
      };
      this._modifiedZones.add(z);
      this._lastRenderedZone = null;

      // Send default coordinates to ESP32
      this._setNumber(this._entities[`zone${z}_x1`], defX1);
      this._setNumber(this._entities[`zone${z}_y1`], defY1);
      this._setNumber(this._entities[`zone${z}_x2`], defX2);
      this._setNumber(this._entities[`zone${z}_y2`], defY2);
      this._setNumber(this._entities[`zone${z}_angle`], 0);

      this._showToast(res.ok
        ? `Zone ${z} added in room center (${boxW}×${boxD}mm). Drag on map or edit below!`
        : `Zone ${z} added in room center (${res.okCount}/${res.total} entities ready).`);
    } finally {
      this._zonePending = false;
      this._renderZoneCardsAndStepper();
      this._updateViewfinder();
    }
  }

  async _disableZone(z) {
    if (this._zonePending || !this._entities || !this._hass) return;
    const ent = this._entities;
    if (!confirm(`Disable Zone ${z}? Its coordinates will be reset to 0 and entities will be disabled in Home Assistant.`)) return;
    this._zonePending = true;
    this._renderZoneCardsAndStepper();
    try {
      // Clear coordinates on the ESP32 first, then disable the entities
      await Promise.allSettled(["x1", "y1", "x2", "y2", "angle"].map(k => this._setNumber(ent[`zone${z}_${k}`], 0)));
      const res = await RadarVisibilityManager.disableZone(this._hass, ent, z);
      if (this._locallyEnabledZones) this._locallyEnabledZones.delete(z);
      if (res.reason === "admin") {
        this._showToast("⚠️ Only Home Assistant administrators can disable zone entities.");
      } else if (!res.okCount) {
        this._showToast(`⚠️ Could not disable Zone ${z} entities in Home Assistant (see browser console).`);
      } else {
        this._showToast(`Zone ${z} disabled and coordinates cleared.`);
      }
      const remaining = RadarEntityResolver.getActiveZones(radarStableHass(this._hass), ent, this._locallyEnabledZones).filter(n => n !== z);
      this._selectedZone = remaining.length > 0 ? remaining[0] : 1;
    } finally {
      this._zonePending = false;
      this._renderZoneCardsAndStepper();
      this._updateViewfinder();
    }
  }

  _renderZoneCardsAndStepper() {
    const grid = this.shadowRoot.getElementById("zonesCardsGrid");
    if (!grid || !this._hass || !this._entities) return;

    const ent = this._entities;
    const stableHass = radarStableHass(this._hass);
    const states = stableHass.states;       // zone values: last-known-good (survive reloads)
    const liveStates = this._hass.states;   // live telemetry (targets, calibration status)

    if (!this._locallyEnabledZones) this._locallyEnabledZones = new Set();

    const getVal = (id, def = 0) => {
      if (!id || !states[id]) return def;
      const v = parseFloat(states[id].state);
      return Number.isFinite(v) ? v : def;
    };
    const getState = (id, def = "off") => (id && states[id]) ? states[id].state : def;
    const getLive = (id, def = 0) => {
      if (!id || !liveStates[id]) return def;
      const v = parseFloat(liveStates[id].state);
      return Number.isFinite(v) ? v : def;
    };

    const activeList = RadarEntityResolver.getActiveZones(stableHass, ent, this._locallyEnabledZones);
    const pending = Boolean(this._zonePending);

    const toolbar = this.shadowRoot.getElementById("zonesToolbar");
    if (toolbar) {
      radarSetHtml(toolbar, `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:8px; flex-wrap:wrap; padding: 2px 2px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; font-size:0.92rem;">Zones: <span style="color:var(--primary-color);">${activeList.length} / 10</span></span>
            ${activeList.length === 0 ? `<span style="font-size:0.75rem; color:var(--text-muted);">(None active)</span>` : ""}
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${activeList.length < 10
              ? `<button class="btn-primary" id="btnAddZoneTop" ${pending ? "disabled" : ""} style="padding:6px 14px; font-size:0.82rem;${pending ? " opacity:0.6; cursor:wait;" : ""}">${pending ? "⏳ Working…" : "➕ Add Zone"}</button>`
              : `<span style="font-size:0.78rem; color:var(--text-muted); padding:6px 0;">Max 10 zones</span>`}
          </div>
        </div>
      `);
    }

    const stepperBox = this.shadowRoot.getElementById("zoneStepperBox");
    if (activeList.length === 0) {
      radarSetHtml(grid, `
        <div style="grid-column: 1 / -1; padding: 32px 16px; text-align: center; background: rgba(255,255,255,0.02); border: 1px dashed var(--border-color); border-radius: 12px;">
          <div style="font-size: 2.2rem; margin-bottom: 8px;">🎯</div>
          <div style="font-weight: 700; font-size: 1rem; margin-bottom: 4px;">No Active Zones</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 16px; max-width: 360px; margin-left: auto; margin-right: auto;">
            Software zones allow you to define custom detection areas (beds, desks) or exclusion masks to ignore ceiling fans and pets.
          </div>
          <button class="btn-primary" id="btnAddFirstZone" ${pending ? "disabled" : ""} style="padding: 9px 20px; font-size: 0.88rem;${pending ? " opacity:0.6; cursor:wait;" : ""}">${pending ? "⏳ Working…" : "➕ Add Zone 1"}</button>
        </div>
      `);
      if (stepperBox) {
        stepperBox.style.display = "none";
      }
      this._lastRenderedZone = null;
      return;
    }

    if (stepperBox) {
      stepperBox.style.display = "block";
    }

    if (!activeList.includes(this._selectedZone)) {
      this._selectedZone = activeList[0];
    }

    let cardsHtml = "";
    for (const z of activeList) {
      let x1 = getVal(ent[`zone${z}_x1`]);
      let y1 = getVal(ent[`zone${z}_y1`]);
      let x2 = getVal(ent[`zone${z}_x2`]);
      let y2 = getVal(ent[`zone${z}_y2`]);
      let angle = getVal(ent[`zone${z}_angle`], 0);

      if (this._zoneEditCoords && this._zoneEditCoords[z]) {
        x1 = this._zoneEditCoords[z].x1;
        y1 = this._zoneEditCoords[z].y1;
        x2 = this._zoneEditCoords[z].x2;
        y2 = this._zoneEditCoords[z].y2;
        angle = this._zoneEditCoords[z].angle || 0;
      }
      const isConfigured = !(x1 === 0 && x2 === 0 && y1 === 0 && y2 === 0);
      const isOcc = getState(ent[`zone${z}_occupancy`]) === "on";
      const isExcl = getState(ent[`zone${z}_mode`]) === "Exclusion";
      const isSelected = z === this._selectedZone;

      const width = isConfigured ? Math.abs(x2 - x1) : 0;
      const depth = isConfigured ? Math.abs(y2 - y1) : 0;

      cardsHtml += `
        <div class="zone-card ${isSelected ? "selected" : ""} ${isExcl ? "exclusion" : ""}" data-zone="${z}">
          <div class="zone-card-header">
            <div class="zone-card-title">${isExcl ? "🛡️" : "🎯"} Zone ${z}</div>
            <div style="display:flex; gap:6px; align-items:center;">
              <div class="zone-status-badge ${isExcl ? "exclusion" : ""} ${isOcc ? "occupied" : ""}">
                ${isExcl ? (isOcc ? "⚠️ MASKED" : "MASK") : (isOcc ? "OCCUPIED" : (isConfigured ? "ACTIVE" : "EMPTY"))}
              </div>
              <button class="btn-zone-disable" data-zone="${z}" ${pending ? "disabled" : ""} style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:0.85rem; padding:2px 4px; border-radius:4px;" title="Disable Zone ${z} and remove from Home Assistant">🗑️</button>
            </div>
          </div>
          <div class="zone-coords-info">
            ${isConfigured ? `
              <div>Size: <b>${width} × ${depth} mm</b></div>
              <div>Center: (${Math.round((x1+x2)/2)}, ${Math.round((y1+y2)/2)}) ${angle !== 0 ? `[${angle}°]` : ""}</div>
              <div>Mode: <b>${isExcl ? "🔴 Exclusion Mask" : "🟢 Detection Zone"}</b></div>
            ` : `
              <div>Not configured yet (${isExcl ? "Mask" : "Detection"})</div>
              <div>Click to setup with walk-in wizard</div>
            `}
          </div>
        </div>
      `;
    }
    radarSetHtml(grid, cardsHtml);

    const curZ = this._selectedZone;
    let x1 = getVal(ent[`zone${curZ}_x1`]);
    let y1 = getVal(ent[`zone${curZ}_y1`]);
    let x2 = getVal(ent[`zone${curZ}_x2`]);
    let y2 = getVal(ent[`zone${curZ}_y2`]);
    let angle = getVal(ent[`zone${curZ}_angle`], 0);

    if (this._zoneEditCoords && this._zoneEditCoords[curZ]) {
      x1 = this._zoneEditCoords[curZ].x1;
      y1 = this._zoneEditCoords[curZ].y1;
      x2 = this._zoneEditCoords[curZ].x2;
      y2 = this._zoneEditCoords[curZ].y2;
      angle = this._zoneEditCoords[curZ].angle || 0;
    }
    const isOcc = getState(ent[`zone${curZ}_occupancy`]) === "on";
    const isExcl = getState(ent[`zone${curZ}_mode`]) === "Exclusion";

    const t1Dist = getLive(ent.target1_distance, 0);
    const t1RawX = getLive(ent.target1_x, NaN);
    const t1RawY = getLive(ent.target1_y, NaN);
    const hasT1 = Number.isFinite(t1RawX) && Number.isFinite(t1RawY) && t1Dist > 0;
    const t1Aligned = hasT1
      ? RoomGeometry.rotateToRoomAligned(t1RawX, t1RawY, this._formState.mountingYaw || 0, Boolean(this._formState.invertX))
      : { x: 0, y: 0 };

    const rawCalStatus = (ent.zone_status && liveStates[ent.zone_status]) ? liveStates[ent.zone_status].state : "";
    const calStatusMsg = (rawCalStatus && rawCalStatus !== "unknown" && rawCalStatus !== "unavailable") ? rawCalStatus : "";

    const stepPill = this.shadowRoot.getElementById("stepPill");
    const stepTitle = this.shadowRoot.getElementById("stepTitle");
    const stepInstr = this.shadowRoot.getElementById("stepInstruction");
    const stepContent = this.shadowRoot.getElementById("stepInteractiveContent");

    if (!stepContent) return;

    stepPill.textContent = `Zone ${curZ}`;
    stepTitle.textContent = `Zone ${curZ} Calibration & Manual Coordinates`;
    radarSetHtml(stepInstr, `
      <div>Live Target Lock (Room-Aligned): <b>${hasT1 ? `Target 1 at X:${Math.round(t1Aligned.x)} Y:${Math.round(t1Aligned.y)} mm (${Math.round(t1Dist)}mm)` : "No targets in room — walk in to calibrate"}</b></div>
      ${calStatusMsg ? `<div style="margin-top:6px; padding:6px 10px; border-radius:6px; background:rgba(56, 189, 248, 0.12); border:1px solid rgba(56, 189, 248, 0.3); color:#bae6fd; font-size:0.8rem;">📡 ${calStatusMsg}</div>` : ""}
    `);

    // Only re-build stepContent if zone selection changed to avoid interrupting manual input typing
    if (this._lastRenderedZone !== curZ) {
      this._lastRenderedZone = curZ;
      this._zoneDirty = false;
      this._lastSyncedZoneSig = `${curZ}:${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)},${Math.round(angle)}`;

      stepContent.innerHTML = `
        <!-- Zone Mode Switcher -->
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; padding:10px 14px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color);">
          <div>
            <div style="font-weight:700; font-size:0.88rem;">Zone ${curZ} Mode</div>
            <div id="zoneModeDesc" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
              ${isExcl ? "🔴 Exclusion Mask — targets inside are ignored (fans, robot vacuums, pets)" : "🟢 Detection Zone — tracks occupants, presence memory & counts"}
            </div>
          </div>
          <button id="btnToggleZoneMode" class="${isExcl ? "btn-danger" : "btn-primary"}" style="padding:6px 14px; font-size:0.8rem; font-weight:700; border-radius:6px; cursor:pointer;">
            ${isExcl ? "🛡️ Mode: Exclusion" : "🎯 Mode: Detection"}
          </button>
        </div>

        <!-- Walk-in Wizard Buttons -->
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px;">
          <button class="btn-primary" style="padding:8px 14px; font-size:0.82rem;" id="btnCaptureCorner1">📍 1. Capture Corner 1</button>
          <button class="btn-primary" style="padding:8px 14px; font-size:0.82rem;" id="btnCaptureCorner2">📍 2. Capture Corner 2 & Save</button>
          <button class="btn-danger" style="padding:8px 14px; font-size:0.82rem;" id="btnClearZone">🗑️ Clear Coords</button>
          <button class="btn-secondary" style="padding:8px 14px; font-size:0.82rem; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5;" id="btnDisableCurZone">🚫 Disable Zone ${curZ}</button>
        </div>

        <div style="font-size:0.8rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; margin-bottom:8px;">
          Manual Coordinates & ±50mm Nudges
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-bottom:14px;">
          <div class="form-group" style="min-width:0;">
            <label class="form-label">X1 (mm)</label>
            <input type="number" class="form-input" id="inpZone_x1" value="${Math.round(x1)}" style="margin-bottom:4px;" />
            <div style="display:flex; gap:4px;">
              <button class="btn-nudge" data-coord="x1" data-delta="-50" style="flex:1;">-50</button>
              <button class="btn-nudge" data-coord="x1" data-delta="50" style="flex:1;">+50</button>
            </div>
          </div>

          <div class="form-group" style="min-width:0;">
            <label class="form-label">Y1 (mm)</label>
            <input type="number" class="form-input" id="inpZone_y1" value="${Math.round(y1)}" style="margin-bottom:4px;" />
            <div style="display:flex; gap:4px;">
              <button class="btn-nudge" data-coord="y1" data-delta="-50" style="flex:1;">-50</button>
              <button class="btn-nudge" data-coord="y1" data-delta="50" style="flex:1;">+50</button>
            </div>
          </div>

          <div class="form-group" style="min-width:0;">
            <label class="form-label">X2 (mm)</label>
            <input type="number" class="form-input" id="inpZone_x2" value="${Math.round(x2)}" style="margin-bottom:4px;" />
            <div style="display:flex; gap:4px;">
              <button class="btn-nudge" data-coord="x2" data-delta="-50" style="flex:1;">-50</button>
              <button class="btn-nudge" data-coord="x2" data-delta="50" style="flex:1;">+50</button>
            </div>
          </div>

          <div class="form-group" style="min-width:0;">
            <label class="form-label">Y2 (mm)</label>
            <input type="number" class="form-input" id="inpZone_y2" value="${Math.round(y2)}" style="margin-bottom:4px;" />
            <div style="display:flex; gap:4px;">
              <button class="btn-nudge" data-coord="y2" data-delta="-50" style="flex:1;">-50</button>
              <button class="btn-nudge" data-coord="y2" data-delta="50" style="flex:1;">+50</button>
            </div>
          </div>

          <div class="form-group" style="min-width:0;">
            <label class="form-label">Angle (°)</label>
            <input type="number" class="form-input" id="inpZone_angle" value="${Math.round(angle)}" style="margin-bottom:4px;" />
            <div style="display:flex; gap:4px;">
              <button class="btn-nudge" data-coord="angle" data-delta="-5" style="flex:1;">-5°</button>
              <button class="btn-nudge" data-coord="angle" data-delta="5" style="flex:1;">+5°</button>
            </div>
          </div>
        </div>

        <div style="display:flex; gap:10px; margin-bottom:14px;">
          <button class="btn-primary" style="padding:10px 18px; font-size:0.85rem;" id="btnSaveZoneManual">
            💾 Save Zone ${curZ} Coordinates to ESP32
          </button>
        </div>

        <div id="zoneLiveVerifBox" style="padding:10px; border-radius:8px; background:${isOcc ? "rgba(16, 185, 129, 0.15)" : "rgba(255, 255, 255, 0.04)"}; border:1px solid ${isOcc ? "rgba(16, 185, 129, 0.4)" : "var(--border-color)"}; display:flex; align-items:center; justify-content:space-between;">
          <span style="font-size:0.85rem; font-weight:600;">Zone ${curZ} Live Verification:</span>
          <span id="zoneLiveVerifPill" style="font-size:0.85rem; font-weight:700; color:${isOcc ? (isExcl ? "#f87171" : "#34d399") : "var(--text-muted)"};">
            ${isOcc ? (isExcl ? "⚠️ MASK TRIGGERED" : "👤 OCCUPIED") : "⚪ CLEAR"}
          </span>
        </div>
      `;

      const btnToggleMode = stepContent.querySelector("#btnToggleZoneMode");
      if (btnToggleMode) {
        btnToggleMode.addEventListener("click", () => {
          const modeEntity = ent[`zone${curZ}_mode`];
          const curState = (this._hass && this._hass.states[modeEntity]) ? this._hass.states[modeEntity].state : (isExcl ? "Exclusion" : "Detection");
          const newMode = (curState === "Exclusion") ? "Detection" : "Exclusion";
          this._setSelect(modeEntity, newMode);
          // The button/description update non-destructively when HA reports the new state
          this._showToast(`Zone ${curZ} mode set to ${newMode}.`);
        });
      }

      const btnC1 = stepContent.querySelector("#btnCaptureCorner1");
      if (btnC1) {
        btnC1.addEventListener("click", () => {
          this._setSelect(ent.zone_select, `Zone ${curZ}`);
          setTimeout(() => {
            this._pressButton(ent.btn_corner_1);
            this._showToast(`📍 Corner 1 command sent for Zone ${curZ}. Walk to Corner 2 next.`);
          }, 150);
        });
      }

      const btnC2 = stepContent.querySelector("#btnCaptureCorner2");
      if (btnC2) {
        btnC2.addEventListener("click", () => {
          this._zoneDirty = false;
          this._setSelect(ent.zone_select, `Zone ${curZ}`);
          setTimeout(() => {
            this._pressButton(ent.btn_corner_2);
            this._showToast(`✅ Corner 2 command sent for Zone ${curZ}!`);
          }, 150);
        });
      }

      const btnClr = stepContent.querySelector("#btnClearZone");
      if (btnClr) {
        btnClr.addEventListener("click", () => {
          if (confirm(`Clear coordinates for Zone ${curZ}?`)) {
            this._zoneDirty = false;
            if (ent.btn_clear_zone && states[ent.btn_clear_zone]) {
              this._setSelect(ent.zone_select, `Zone ${curZ}`);
              setTimeout(() => {
                this._pressButton(ent.btn_clear_zone);
                this._showToast(`Zone ${curZ} coordinates cleared.`);
              }, 150);
            } else {
              this._setNumber(ent[`zone${curZ}_x1`], 0);
              this._setNumber(ent[`zone${curZ}_y1`], 0);
              this._setNumber(ent[`zone${curZ}_x2`], 0);
              this._setNumber(ent[`zone${curZ}_y2`], 0);
              this._setNumber(ent[`zone${curZ}_angle`], 0);
              this._showToast(`Zone ${curZ} coordinates cleared.`);
            }
          }
        });
      }

      const btnDisCur = stepContent.querySelector("#btnDisableCurZone");
      if (btnDisCur) {
        btnDisCur.addEventListener("click", () => {
          this._disableZone(curZ);
        });
      }

      // Manual Save Button
      const btnSaveManual = stepContent.querySelector("#btnSaveZoneManual");
      if (btnSaveManual) {
        btnSaveManual.addEventListener("click", () => {
          const zx1 = parseFloat(stepContent.querySelector("#inpZone_x1").value) || 0;
          const zy1 = parseFloat(stepContent.querySelector("#inpZone_y1").value) || 0;
          const zx2 = parseFloat(stepContent.querySelector("#inpZone_x2").value) || 0;
          const zy2 = parseFloat(stepContent.querySelector("#inpZone_y2").value) || 0;
          const zang = parseFloat(stepContent.querySelector("#inpZone_angle").value) || 0;

          this._setNumber(ent[`zone${curZ}_x1`], zx1);
          this._setNumber(ent[`zone${curZ}_y1`], zy1);
          this._setNumber(ent[`zone${curZ}_x2`], zx2);
          this._setNumber(ent[`zone${curZ}_y2`], zy2);
          this._setNumber(ent[`zone${curZ}_angle`], zang);
          this._zoneDirty = false;
          this._showToast(`💾 Zone ${curZ} coordinates saved to ESP32!`);
          this._updateViewfinder();
        });
      }

      // Live typing update in Viewfinder
      ["inpZone_x1", "inpZone_y1", "inpZone_x2", "inpZone_y2", "inpZone_angle"].forEach(id => {
        const input = stepContent.querySelector(`#${id}`);
        if (input) {
          input.addEventListener("input", () => {
            this._zoneDirty = true;
            this._updateViewfinder();
          });
        }
      });

      // Nudge buttons
      stepContent.querySelectorAll(".btn-nudge").forEach(b => {
        b.addEventListener("click", () => {
          const coord = b.dataset.coord;
          const delta = parseFloat(b.dataset.delta);
          const input = stepContent.querySelector(`#inpZone_${coord}`);
          if (input) {
            const currentVal = parseFloat(input.value) || 0;
            const newVal = currentVal + delta;
            input.value = newVal;
            // Nudges are written to the ESP32 immediately, so they don't count as unsaved edits
            const entityId = ent[`zone${curZ}_${coord}`];
            this._setNumber(entityId, newVal);
            this._updateViewfinder();
          }
        });
      });
    } else {
      // Sync ESP32 entity updates (e.g. walk-in Corner 2 capture or Clear) into inputs & viewfinder
      // whenever the user is NOT actively typing unsaved edits
      const newSig = `${curZ}:${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)},${Math.round(angle)}`;
      const activeId = (this.shadowRoot.activeElement && this.shadowRoot.activeElement.id) || "";
      const isFocusedOnZoneInput = activeId.startsWith("inpZone_");
      if (!this._zoneDirty && !isFocusedOnZoneInput && this._lastSyncedZoneSig !== newSig) {
        this._lastSyncedZoneSig = newSig;
        const setIfPresent = (id, v) => {
          const el = stepContent.querySelector(`#${id}`);
          if (el) el.value = Math.round(v);
        };
        setIfPresent("inpZone_x1", x1);
        setIfPresent("inpZone_y1", y1);
        setIfPresent("inpZone_x2", x2);
        setIfPresent("inpZone_y2", y2);
        setIfPresent("inpZone_angle", angle);
        this._updateViewfinder();
      }

      // Non-destructive update of mode button and description when not re-rendering
      const btnToggle = stepContent.querySelector("#btnToggleZoneMode");
      const modeDesc = stepContent.querySelector("#zoneModeDesc");
      if (btnToggle) {
        btnToggle.className = isExcl ? "btn-danger" : "btn-primary";
        btnToggle.textContent = isExcl ? "🛡️ Mode: Exclusion" : "🎯 Mode: Detection";
      }
      if (modeDesc) {
        modeDesc.textContent = isExcl
          ? "🔴 Exclusion Mask — targets inside are ignored (fans, robot vacuums, pets)"
          : "🟢 Detection Zone — tracks occupants, presence memory & counts";
      }

      // Non-destructive update of status pill when not re-rendering
      const pill = stepContent.querySelector("#zoneLiveVerifPill");
      const box = stepContent.querySelector("#zoneLiveVerifBox");
      if (pill && box) {
        pill.textContent = isOcc ? (isExcl ? "⚠️ MASK TRIGGERED" : "👤 OCCUPIED") : "⚪ CLEAR";
        pill.style.color = isOcc ? (isExcl ? "#f87171" : "#34d399") : "var(--text-muted)";
        box.style.background = isOcc ? (isExcl ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)") : "rgba(255, 255, 255, 0.04)";
        box.style.borderColor = isOcc ? (isExcl ? "rgba(239, 68, 68, 0.4)" : "rgba(16, 185, 129, 0.4)") : "var(--border-color)";
      }
    }
  }
}



// ====================================================================
// ELEMENT REGISTRATION & COMPATIBILITY
// ====================================================================
const defineElement = (tag, cls) => {
  if (!customElements.get(tag)) {
    try {
      customElements.define(tag, cls);
    } catch (e) {
      console.warn(`[PRESENCE-RADAR-CARDS] Could not register ${tag}:`, e);
    }
  }
};

defineElement("radar-map-card-editor", RadarMapCardEditor);
defineElement("radar-map-card", RadarMapCard);
defineElement("presence-radar-card", class extends RadarMapCard {});
defineElement("radar-calibration-card-editor", RadarCalibrationCardEditor);
defineElement("radar-calibration-card", RadarCalibrationCard);
defineElement("presence-calibration-card", class extends RadarCalibrationCard {});

console.log(`[PRESENCE-RADAR-CARDS] v${CARD_VERSION} High-Precision mmWave Radar Suite initialized.`);
