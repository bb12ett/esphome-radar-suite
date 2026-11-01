#pragma once
#include "esphome.h"
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace esphome {
namespace presence_memory {

// All tracker coordinates are in the "room-aligned" frame (Frame 2):
// origin at the sensor, axes already rotated by sensor_mounting_angle,
// +X to the right along the front wall, +Y into the room.

struct TargetData {
  float x{0};
  float y{0};
  float dist{0};
  float speed{0};
  float angle{0};
  bool active{false};      // Active inside room boundaries
  bool raw_active{false};  // Active on raw radar (even if outside virtual room walls)
};

struct CalibrationPoint {
  float x{0};
  float y{0};
  bool set{false};
};

inline void rotate_point(float x, float y, float angle_deg, float &ox, float &oy) {
  if (angle_deg == 0.0f) {
    ox = x;
    oy = y;
    return;
  }
  float rad = angle_deg * (static_cast<float>(M_PI) / 180.0f);
  float c = cosf(rad);
  float s = sinf(rad);
  ox = x * c - y * s;
  oy = x * s + y * c;
}

inline bool is_raw_tracked(const TargetData &t) {
  return (t.raw_active || t.active) && !std::isnan(t.dist) && t.dist > 0.0f &&
         !std::isnan(t.x) && !std::isnan(t.y);
}

// Outer room walls (room-aligned frame). All-zero means "no boundary configured".
struct RoomBounds {
  bool valid{false};
  float min_x{0};
  float max_x{0};
  float min_y{0};
  float max_y{0};
};

inline RoomBounds make_room_bounds(float x1, float y1, float x2, float y2) {
  RoomBounds b;
  b.valid = !(x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0);
  b.min_x = std::min(x1, x2);
  b.max_x = std::max(x1, x2);
  b.min_y = std::min(y1, y2);
  b.max_y = std::max(y1, y2);
  return b;
}

inline bool inside_room(const RoomBounds &b, const TargetData &t, float max_dist_mm) {
  if (b.valid) {
    return t.x >= b.min_x && t.x <= b.max_x && t.y >= b.min_y && t.y <= b.max_y;
  }
  return t.dist <= max_dist_mm;
}

// True when a target's last position was within margin_mm of a room boundary or max range.
inline bool near_room_exit(const RoomBounds &b, const TargetData &last, float max_dist_mm, float margin_mm) {
  if (last.dist >= max_dist_mm - margin_mm) return true;
  if (!b.valid) return false;
  return (last.x - b.min_x) <= margin_mm || (b.max_x - last.x) <= margin_mm ||
         (last.y - b.min_y) <= margin_mm || (b.max_y - last.y) <= margin_mm;
}

// Tracks an occupant's last known position and rolling 0.6s-1.2s 2D displacement so we can
// distinguish someone sitting still against a wall from someone walking out a doorway
// (both radial Doppler motion and tangential lateral motion).
struct OccupantRecord {
  TargetData last_pos;
  float prev_anchor_x{0};
  float prev_anchor_y{0};
  float curr_anchor_x{0};
  float curr_anchor_y{0};
  uint32_t curr_anchor_ms{0};
  uint32_t first_seen_ms{0};
  bool was_moving{false};

  void record(const TargetData &t, uint32_t now) {
    if (first_seen_ms == 0) {
      first_seen_ms = now;
      prev_anchor_x = curr_anchor_x = t.x;
      prev_anchor_y = curr_anchor_y = t.y;
      curr_anchor_ms = now;
    } else if (now - curr_anchor_ms >= 600) {
      prev_anchor_x = curr_anchor_x;
      prev_anchor_y = curr_anchor_y;
      curr_anchor_x = t.x;
      curr_anchor_y = t.y;
      curr_anchor_ms = now;
    }
    float disp = std::hypot(t.x - prev_anchor_x, t.y - prev_anchor_y);
    bool transient = (now - first_seen_ms) < 1200;
    was_moving = (fabsf(t.speed) >= 120.0f) || (disp >= 180.0f) || transient;
    last_pos = t;
  }

  void clear() {
    first_seen_ms = 0;
    curr_anchor_ms = 0;
    was_moving = false;
  }
};

// A target seen outside the zone/room accounts for a vanished occupant only if it appears
// shortly after and within realistic walking distance of where that occupant was last seen.
// This handles LD2450 slot swaps while preventing a distant passerby from unlatching someone else.
static const uint32_t REACQUIRE_WINDOW_MS = 3000;
inline bool plausibly_same_person(const TargetData &last, const TargetData &now_t, uint32_t elapsed_ms) {
  if (elapsed_ms > REACQUIRE_WINDOW_MS) return false;
  float max_move = 600.0f + 1.6f * static_cast<float>(elapsed_ms);  // ~1.6 m/s walking + radar jitter
  return std::hypot(now_t.x - last.x, now_t.y - last.y) <= max_move;
}

class ZoneCalibrator {
 public:
  CalibrationPoint point_a[5];  // 0..3: Zones 1..4, 4: Room Boundary
  TargetData last_valid_target;
  uint32_t last_valid_time{0};

  void update_targets(const TargetData targets[3]) {
    for (int i = 0; i < 3; i++) {
      if (targets[i].active && targets[i].dist > 0.0f && !std::isnan(targets[i].x) && !std::isnan(targets[i].y)) {
        last_valid_target = targets[i];
        last_valid_time = millis();
        return;
      }
    }
  }

  bool get_active_position(const TargetData targets[3], float &x, float &y, float &dist) {
    // 1. Prefer live target
    for (int i = 0; i < 3; i++) {
      if (targets[i].active && targets[i].dist > 0.0f && !std::isnan(targets[i].x) && !std::isnan(targets[i].y)) {
        x = targets[i].x;
        y = targets[i].y;
        dist = targets[i].dist;
        return true;
      }
    }
    // 2. Fall back to target seen in last 3 seconds
    if (last_valid_target.active && (millis() - last_valid_time < 3000)) {
      x = last_valid_target.x;
      y = last_valid_target.y;
      dist = last_valid_target.dist;
      return true;
    }
    return false;
  }
};

// Zone occupancy with stationary memory (vanish protection).
//
// When nobody is currently detected inside the zone, each occupant who was inside is accounted for:
//  - observed outside the zone (including stepping past room walls) near their last position -> walked out
//  - disappeared while moving near a room exit / max range                                   -> walked out
//  - disappeared while stationary inside the zone (even against a wall)                      -> latched still
class ZoneTracker {
 public:
  bool occupied{false};
  bool latched{false};
  int target_count{0};
  uint32_t last_inside_ms{0};

  void update(float x1, float y1, float x2, float y2, float angle_deg,
              const TargetData targets[3],
              const RoomBounds &room,
              float max_dist_mm,
              bool vanish_protection,
              float off_delay_sec,
              float latch_timeout_min,
              float exit_margin_mm) {
    uint32_t now = millis();

    // If unconfigured (all coordinates 0), zone is inactive
    if (x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0) {
      this->reset_();
      return;
    }

    float min_x = std::min(x1, x2);
    float max_x = std::max(x1, x2);
    float min_y = std::min(y1, y2);
    float max_y = std::max(y1, y2);
    float cx = (min_x + max_x) * 0.5f;
    float cy = (min_y + max_y) * 0.5f;
    float half_w = (max_x - min_x) * 0.5f;
    float half_h = (max_y - min_y) * 0.5f;

    auto point_in_zone = [&](float px, float py) -> bool {
      if (angle_deg == 0.0f) {
        return px >= min_x && px <= max_x && py >= min_y && py <= max_y;
      }
      float u = 0, v = 0;
      rotate_point(px - cx, py - cy, -angle_deg, u, v);
      return fabsf(u) <= half_w && fabsf(v) <= half_h;
    };

    uint8_t inside_mask = 0;
    int inside_count = 0;
    for (int i = 0; i < 3; i++) {
      const TargetData &t = targets[i];
      if (!t.active || std::isnan(t.x) || std::isnan(t.y)) continue;
      if (point_in_zone(t.x, t.y)) {
        inside_mask |= (1u << i);
        inside_count++;
        this->rec_[i].record(t, now);
      }
    }
    target_count = inside_count;

    if (inside_count > 0) {
      for (int i = 0; i < 3; i++) {
        if (!(inside_mask & (1u << i))) this->rec_[i].clear();
      }
      occupied = true;
      latched = false;
      last_inside_ms = now;
      this->occupants_ = inside_mask;
      this->outside_used_mask_ = 0;
      return;
    }

    if (!occupied) {
      this->reset_();
      return;
    }

    uint32_t since = now - last_inside_ms;
    uint32_t off_delay_ms = static_cast<uint32_t>(off_delay_sec * 1000.0f);
    uint32_t latch_timeout_ms = static_cast<uint32_t>(latch_timeout_min * 60.0f * 1000.0f);

    // Account for each person who was inside the zone on the last occupied frame
    for (int i = 0; i < 3; i++) {
      uint8_t bit = (1u << i);
      if (!(this->occupants_ & bit)) continue;

      bool accounted = false;
      // 1. Check any raw-tracked target outside the zone (handles both in-room exit & cross-wall exit)
      for (int j = 0; j < 3; j++) {
        uint8_t jbit = (1u << j);
        if (this->outside_used_mask_ & jbit) continue;
        if (!is_raw_tracked(targets[j])) continue;
        if (point_in_zone(targets[j].x, targets[j].y)) continue;
        if (plausibly_same_person(this->rec_[i].last_pos, targets[j], since)) {
          this->outside_used_mask_ |= jbit;
          accounted = true;
          break;
        }
      }

      // 2. Or vanished while actively moving right at a room exit / max range
      if (!accounted && this->rec_[i].was_moving &&
          near_room_exit(room, this->rec_[i].last_pos, max_dist_mm, exit_margin_mm)) {
        accounted = true;
      }

      if (accounted) {
        this->occupants_ &= ~bit;
        this->rec_[i].clear();
      }
    }

    bool someone_unaccounted = (this->occupants_ != 0);

    if (!someone_unaccounted || !vanish_protection) {
      latched = false;
      if (since >= off_delay_ms) {
        this->reset_();
      }
      return;
    }

    // Stationary memory: hold until the person moves again or the watchdog expires
    if (since >= latch_timeout_ms) {
      this->reset_();
    } else {
      occupied = true;
      latched = true;
    }
  }

 protected:
  void reset_() {
    occupied = false;
    latched = false;
    target_count = 0;
    this->occupants_ = 0;
    this->outside_used_mask_ = 0;
    for (int i = 0; i < 3; i++) this->rec_[i].clear();
  }

  uint8_t occupants_{0};
  uint8_t outside_used_mask_{0};
  OccupantRecord rec_[3];
};

// Whole-room occupancy with stationary memory (works both with and without room wall boundaries).
class RoomTracker {
 public:
  bool occupied{false};
  bool latched{false};
  int target_count{0};
  uint32_t last_seen_ms{0};

  void update(const TargetData targets[3],
              float max_dist_mm,
              const RoomBounds &room,
              bool vanish_protection,
              float timeout_sec,
              float latch_timeout_min,
              float exit_margin_mm,
              bool any_zone_latched = false) {
    uint32_t now = millis();
    uint8_t mask = 0;
    int count = 0;

    for (int i = 0; i < 3; i++) {
      const TargetData &t = targets[i];
      if (!t.active || !is_raw_tracked(t)) continue;
      if (inside_room(room, t, max_dist_mm)) {
        mask |= (1u << i);
        count++;
        this->rec_[i].record(t, now);
      }
    }
    target_count = count;

    if (count > 0) {
      for (int i = 0; i < 3; i++) {
        if (!(mask & (1u << i))) this->rec_[i].clear();
      }
      occupied = true;
      latched = false;
      last_seen_ms = now;
      this->occupants_ = mask;
      this->outside_used_mask_ = 0;
      return;
    }

    if (!occupied) {
      this->reset_();
      return;
    }

    uint32_t since = now - last_seen_ms;
    uint32_t timeout_ms = static_cast<uint32_t>(timeout_sec * 1000.0f);
    uint32_t latch_timeout_ms = static_cast<uint32_t>(latch_timeout_min * 60.0f * 1000.0f);

    // Account for each occupant who was inside the room on the last occupied frame
    for (int i = 0; i < 3; i++) {
      uint8_t bit = (1u << i);
      if (!(this->occupants_ & bit)) continue;

      bool accounted = false;
      // 1. Observed stepping outside the room boundaries / beyond max_dist_mm on raw radar
      for (int j = 0; j < 3; j++) {
        uint8_t jbit = (1u << j);
        if (this->outside_used_mask_ & jbit) continue;
        if (!is_raw_tracked(targets[j])) continue;
        if (inside_room(room, targets[j], max_dist_mm)) continue;
        if (plausibly_same_person(this->rec_[i].last_pos, targets[j], since)) {
          this->outside_used_mask_ |= jbit;
          accounted = true;
          break;
        }
      }

      // 2. Or vanished while actively moving within exit_margin_mm of a room boundary / max range
      if (!accounted && this->rec_[i].was_moving &&
          near_room_exit(room, this->rec_[i].last_pos, max_dist_mm, exit_margin_mm)) {
        accounted = true;
      }

      if (accounted) {
        this->occupants_ &= ~bit;
        this->rec_[i].clear();
      }
    }

    // If any configured sub-zone is currently latched, hold room occupancy as well
    if (any_zone_latched) {
      occupied = true;
      latched = true;
      return;
    }

    bool someone_unaccounted = (this->occupants_ != 0);

    if (!someone_unaccounted || !vanish_protection) {
      latched = false;
      if (since >= timeout_ms) {
        this->reset_();
      }
      return;
    }

    if (since >= latch_timeout_ms) {
      this->reset_();
    } else {
      occupied = true;
      latched = true;
    }
  }

 protected:
  void reset_() {
    occupied = false;
    latched = false;
    target_count = 0;
    this->occupants_ = 0;
    this->outside_used_mask_ = 0;
    for (int i = 0; i < 3; i++) this->rec_[i].clear();
  }

  uint8_t occupants_{0};
  uint8_t outside_used_mask_{0};
  OccupantRecord rec_[3];
};

// Global state instance shared with ESPHome lambdas
static ZoneCalibrator g_calibrator;

}  // namespace presence_memory
}  // namespace esphome
