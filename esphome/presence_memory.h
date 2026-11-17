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

// Convert raw LD2450 chip coordinates (Frame 1: +X = sensor's own right looking out into the room)
// into top-down Room-Aligned coordinates (Frame 2: +X = room right when facing the front wall,
// +Y = depth into the room away from the front wall).
// Standard upright mount (invert_x = false) negates rx before rotating clockwise by mount_yaw_deg.
// Upside-down 180-deg rolled mount (invert_x = true) keeps +rx.
inline void sensor_raw_to_room_aligned(float rx, float ry, float mount_yaw_deg, bool invert_x,
                                       float &ox, float &oy) {
  float lx = invert_x ? rx : -rx;
  rotate_point(lx, ry, mount_yaw_deg, ox, oy);
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
static const float SLOT_SWAP_MATCH_MM = 400.0f;
static const float WAKE_ORIGIN_RADIUS_MM = 1200.0f;
static const float WAKE_UNLATCH_RADIUS_MM = 1400.0f;
static const float WAKE_MIN_SPEED_MMS = 120.0f;

inline bool plausibly_same_person(const TargetData &last, const TargetData &now_t, uint32_t elapsed_ms) {
  if (elapsed_ms > REACQUIRE_WINDOW_MS) return false;
  float max_move = 600.0f + 1.6f * static_cast<float>(elapsed_ms);  // ~1.6 m/s walking + radar jitter
  return std::hypot(now_t.x - last.x, now_t.y - last.y) <= max_move;
}

// Zone coordinate collision test (with rotation support)
inline bool is_point_in_zone(float x1, float y1, float x2, float y2, float angle_deg, float px, float py) {
  if (x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0) return false;
  float min_x = std::min(x1, x2);
  float max_x = std::max(x1, x2);
  float min_y = std::min(y1, y2);
  float max_y = std::max(y1, y2);
  if (angle_deg == 0.0f) {
    return px >= min_x && px <= max_x && py >= min_y && py <= max_y;
  }
  float cx = (min_x + max_x) * 0.5f;
  float cy = (min_y + max_y) * 0.5f;
  float half_w = (max_x - min_x) * 0.5f;
  float half_h = (max_y - min_y) * 0.5f;
  float u = 0, v = 0;
  rotate_point(px - cx, py - cy, -angle_deg, u, v);
  return fabsf(u) <= half_w && fabsf(v) <= half_h;
}

// When a target has been latched stationary (> REACQUIRE_WINDOW_MS) and then wakes up and steps
// directly outside the zone/room without hitting an inside frame first, allow an unlatch if a
// non-preexisting moving target appears right next to the latched position.
inline bool plausibly_woke_up(const TargetData &last, const TargetData &now_t) {
  if (fabsf(now_t.speed) < WAKE_MIN_SPEED_MMS) return false;
  return std::hypot(now_t.x - last.x, now_t.y - last.y) <= WAKE_UNLATCH_RADIUS_MM;
}

// Matches each active slot in curr_mask to the closest unused slot in prev_mask within max_mm
// (breaking ties in favor of the same slot index). out_match[i] is -1 if unmatched.
inline void match_previous_slots(const TargetData curr[3],
                                 uint8_t curr_mask,
                                 const TargetData prev[3],
                                 uint8_t prev_mask,
                                 float max_mm,
                                 int out_match[3]) {
  for (int i = 0; i < 3; i++) out_match[i] = -1;
  uint8_t curr_used = 0;
  uint8_t prev_used = 0;

  for (int iter = 0; iter < 3; iter++) {
    int best_i = -1;
    int best_k = -1;
    float best_d = max_mm + 1.0f;
    for (int i = 0; i < 3; i++) {
      if (!(curr_mask & (1u << i)) || (curr_used & (1u << i))) continue;
      for (int k = 0; k < 3; k++) {
        if (!(prev_mask & (1u << k)) || (prev_used & (1u << k))) continue;
        float d = std::hypot(curr[i].x - prev[k].x, curr[i].y - prev[k].y);
        if (d > max_mm) continue;
        if (d < best_d - 1e-3f || (fabsf(d - best_d) <= 1e-3f && i == k)) {
          best_d = d;
          best_i = i;
          best_k = k;
        }
      }
    }
    if (best_i < 0) break;
    out_match[best_i] = best_k;
    curr_used |= (1u << best_i);
    prev_used |= (1u << best_k);
  }
}

// Updates per-slot OccupantRecord history while preserving identity across LD2450 slot swaps.
// Without this, a stationary occupant swapping from slot A to slot B resets first_seen_ms and
// triggers transient was_moving = true, causing false unlatches near room walls.
inline void update_inside_records(OccupantRecord rec[3],
                                  const TargetData prev_targets[3],
                                  uint8_t prev_inside_mask,
                                  uint32_t prev_inside_ms,
                                  const TargetData targets[3],
                                  uint8_t inside_mask,
                                  uint32_t now) {
  OccupantRecord prev_rec[3];
  uint8_t valid_prev_mask = 0;
  for (int k = 0; k < 3; k++) {
    prev_rec[k] = rec[k];
    if ((prev_inside_mask & (1u << k)) && prev_rec[k].first_seen_ms != 0) {
      valid_prev_mask |= (1u << k);
    }
  }

  int match[3] = {-1, -1, -1};
  if (prev_inside_ms != 0 && (now - prev_inside_ms) <= 2000 && valid_prev_mask != 0) {
    match_previous_slots(targets, inside_mask, prev_targets, valid_prev_mask, SLOT_SWAP_MATCH_MM, match);
  }

  for (int i = 0; i < 3; i++) {
    if (inside_mask & (1u << i)) {
      if (match[i] >= 0) {
        rec[i] = prev_rec[match[i]];
      } else {
        rec[i].clear();
      }
      rec[i].record(targets[i], now);
    } else {
      rec[i].clear();
    }
  }
}

// Tracks which outside targets already existed (or originated far from any latched occupant)
// so a bystander walking past a latched sofa/zone cannot unlatch the stationary occupant.
inline uint8_t update_external_outside_mask(const TargetData targets[3],
                                            uint8_t inside_mask,
                                            const TargetData prev_raw_targets[3],
                                            uint8_t prev_raw_mask,
                                            uint8_t prev_external_mask,
                                            const OccupantRecord rec[3],
                                            uint8_t occupants_mask,
                                            bool mark_all_outside_as_external) {
  uint8_t next_ext = 0;
  uint8_t outside_mask = 0;
  for (int j = 0; j < 3; j++) {
    if (inside_mask & (1u << j)) continue;
    if (is_raw_tracked(targets[j])) {
      outside_mask |= (1u << j);
    }
  }

  if (mark_all_outside_as_external) {
    return outside_mask;
  }

  int match[3] = {-1, -1, -1};
  match_previous_slots(targets, outside_mask, prev_raw_targets, prev_raw_mask, SLOT_SWAP_MATCH_MM, match);

  for (int j = 0; j < 3; j++) {
    if (!(outside_mask & (1u << j))) continue;
    if (match[j] >= 0) {
      if (prev_external_mask & (1u << match[j])) {
        next_ext |= (1u << j);
      }
    } else {
      // Brand new outside target: mark external unless it originated close to an unaccounted occupant
      bool near_occupant = false;
      for (int i = 0; i < 3; i++) {
        if (!(occupants_mask & (1u << i))) continue;
        if (std::hypot(targets[j].x - rec[i].last_pos.x, targets[j].y - rec[i].last_pos.y) <= WAKE_ORIGIN_RADIUS_MM) {
          near_occupant = true;
          break;
        }
      }
      if (!near_occupant) {
        next_ext |= (1u << j);
      }
    }
  }

  return next_ext;
}

inline void snapshot_raw_targets(const TargetData targets[3], TargetData out_targets[3], uint8_t &out_mask) {
  out_mask = 0;
  for (int i = 0; i < 3; i++) {
    out_targets[i] = targets[i];
    if (is_raw_tracked(targets[i])) {
      out_mask |= (1u << i);
    }
  }
}

class ZoneCalibrator {
 public:
  static constexpr size_t MAX_CALIBRATION_SLOTS = 11;  // 0..9: Zones 1..10, 10: Room Boundary
  CalibrationPoint point_a[MAX_CALIBRATION_SLOTS];
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

// Accounts for each vanished occupant using either a matching outside target (immediate exit
// or waking up near the latched spot) or moving disappearance right at a room exit.
template <typename IsInsideFn>
inline void account_for_vanished_occupants(OccupantRecord rec[3],
                                           uint8_t &occupants_mask,
                                           uint8_t &outside_used_mask,
                                           uint8_t external_mask,
                                           const TargetData targets[3],
                                           const RoomBounds &room,
                                           float max_dist_mm,
                                           float exit_margin_mm,
                                           uint32_t since,
                                           bool is_latched,
                                           IsInsideFn is_inside) {
  for (int i = 0; i < 3; i++) {
    uint8_t bit = (1u << i);
    if (!(occupants_mask & bit)) continue;

    bool accounted = false;
    // 1. Check any non-external raw-tracked target outside the zone/room
    for (int j = 0; j < 3; j++) {
      uint8_t jbit = (1u << j);
      if (outside_used_mask & jbit) continue;
      if (external_mask & jbit) continue;
      if (!is_raw_tracked(targets[j])) continue;
      if (is_inside(targets[j])) continue;

      bool matched_exit = (since <= REACQUIRE_WINDOW_MS)
                              ? plausibly_same_person(rec[i].last_pos, targets[j], since)
                              : (is_latched && plausibly_woke_up(rec[i].last_pos, targets[j]));
      if (matched_exit) {
        outside_used_mask |= jbit;
        accounted = true;
        break;
      }
    }

    // 2. Or vanished while actively moving right at a room exit / max range
    if (!accounted && rec[i].was_moving &&
        near_room_exit(room, rec[i].last_pos, max_dist_mm, exit_margin_mm)) {
      accounted = true;
    }

    if (accounted) {
      occupants_mask &= ~bit;
      rec[i].clear();
    }
  }
}

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

  void update_exclusion(float x1, float y1, float x2, float y2, float angle_deg,
                        const TargetData targets[3]) {
    if (x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0) {
      this->reset_();
      return;
    }
    int count = 0;
    for (int i = 0; i < 3; i++) {
      const TargetData &t = targets[i];
      if (!t.active || std::isnan(t.x) || std::isnan(t.y)) continue;
      if (is_point_in_zone(x1, y1, x2, y2, angle_deg, t.x, t.y)) {
        count++;
      }
    }
    target_count = count;
    occupied = (count > 0);
    latched = false;
  }

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

    auto point_in_zone = [&](float px, float py) -> bool {
      return is_point_in_zone(x1, y1, x2, y2, angle_deg, px, py);
    };

    uint8_t inside_mask = 0;
    int inside_count = 0;
    for (int i = 0; i < 3; i++) {
      const TargetData &t = targets[i];
      if (!t.active || std::isnan(t.x) || std::isnan(t.y)) continue;
      if (point_in_zone(t.x, t.y)) {
        inside_mask |= (1u << i);
        inside_count++;
      }
    }
    target_count = inside_count;

    if (inside_count > 0) {
      update_inside_records(this->rec_, this->prev_inside_targets_, this->prev_inside_mask_,
                            this->last_inside_ms, targets, inside_mask, now);
      for (int i = 0; i < 3; i++) {
        this->prev_inside_targets_[i] = targets[i];
      }
      this->prev_inside_mask_ = inside_mask;
      this->external_mask_ = update_external_outside_mask(
          targets, inside_mask, this->prev_raw_targets_, this->prev_raw_mask_,
          this->external_mask_, this->rec_, inside_mask, true);
      snapshot_raw_targets(targets, this->prev_raw_targets_, this->prev_raw_mask_);

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

    this->external_mask_ = update_external_outside_mask(
        targets, 0, this->prev_raw_targets_, this->prev_raw_mask_,
        this->external_mask_, this->rec_, this->occupants_, false);
    snapshot_raw_targets(targets, this->prev_raw_targets_, this->prev_raw_mask_);

    account_for_vanished_occupants(
        this->rec_, this->occupants_, this->outside_used_mask_, this->external_mask_,
        targets, room, max_dist_mm, exit_margin_mm, since, latched,
        [&](const TargetData &t) { return point_in_zone(t.x, t.y); });

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
    last_inside_ms = 0;
    this->occupants_ = 0;
    this->outside_used_mask_ = 0;
    this->prev_inside_mask_ = 0;
    this->prev_raw_mask_ = 0;
    this->external_mask_ = 0;
    for (int i = 0; i < 3; i++) this->rec_[i].clear();
  }

  uint8_t occupants_{0};
  uint8_t outside_used_mask_{0};
  uint8_t prev_inside_mask_{0};
  uint8_t prev_raw_mask_{0};
  uint8_t external_mask_{0};
  TargetData prev_inside_targets_[3];
  TargetData prev_raw_targets_[3];
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
      }
    }
    target_count = count;

    if (count > 0) {
      update_inside_records(this->rec_, this->prev_inside_targets_, this->prev_inside_mask_,
                            this->last_seen_ms, targets, mask, now);
      for (int i = 0; i < 3; i++) {
        this->prev_inside_targets_[i] = targets[i];
      }
      this->prev_inside_mask_ = mask;
      this->external_mask_ = update_external_outside_mask(
          targets, mask, this->prev_raw_targets_, this->prev_raw_mask_,
          this->external_mask_, this->rec_, mask, true);
      snapshot_raw_targets(targets, this->prev_raw_targets_, this->prev_raw_mask_);

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

    this->external_mask_ = update_external_outside_mask(
        targets, 0, this->prev_raw_targets_, this->prev_raw_mask_,
        this->external_mask_, this->rec_, this->occupants_, false);
    snapshot_raw_targets(targets, this->prev_raw_targets_, this->prev_raw_mask_);

    account_for_vanished_occupants(
        this->rec_, this->occupants_, this->outside_used_mask_, this->external_mask_,
        targets, room, max_dist_mm, exit_margin_mm, since, latched,
        [&](const TargetData &t) { return inside_room(room, t, max_dist_mm); });

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
    last_seen_ms = 0;
    this->occupants_ = 0;
    this->outside_used_mask_ = 0;
    this->prev_inside_mask_ = 0;
    this->prev_raw_mask_ = 0;
    this->external_mask_ = 0;
    for (int i = 0; i < 3; i++) this->rec_[i].clear();
  }

  uint8_t occupants_{0};
  uint8_t outside_used_mask_{0};
  uint8_t prev_inside_mask_{0};
  uint8_t prev_raw_mask_{0};
  uint8_t external_mask_{0};
  TargetData prev_inside_targets_[3];
  TargetData prev_raw_targets_[3];
  OccupantRecord rec_[3];
};

// Global state instance shared with ESPHome lambdas
static ZoneCalibrator g_calibrator;

}  // namespace presence_memory
}  // namespace esphome
