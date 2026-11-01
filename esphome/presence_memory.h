#pragma once
#include "esphome.h"
#include <cmath>

namespace esphome {
namespace presence_memory {

struct TargetData {
  float x{0};
  float y{0};
  float dist{0};
  float speed{0};
  float angle{0};
  bool active{false};
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
  float rad = angle_deg * (M_PI / 180.0f);
  float c = cosf(rad);
  float s = sinf(rad);
  ox = x * c - y * s;
  oy = x * s + y * c;
}

class ZoneCalibrator {
 public:
  CalibrationPoint point_a[5]; // 0..3: Zones 1..4, 4: Room Boundary
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

class ZoneTracker {
 public:
  bool occupied{false};
  bool latched{false};
  int target_count{0};
  uint32_t last_inside_ms{0};
  uint32_t exit_trajectory_start_ms{0};
  float exit_start_dist{0};

  void update(float x1, float y1, float x2, float y2, float angle_deg,
              const TargetData targets[3],
              bool vanish_protection,
              float off_delay_sec,
              float latch_timeout_min,
              float exit_margin_mm) {
    uint32_t now = millis();

    // If unconfigured (all coordinates 0), zone is inactive
    if (x1 == 0 && y1 == 0 && x2 == 0 && y2 == 0) {
      occupied = false;
      latched = false;
      target_count = 0;
      return;
    }

    float min_x = std::min(x1, x2);
    float max_x = std::max(x1, x2);
    float min_y = std::min(y1, y2);
    float max_y = std::max(y1, y2);

    float center_x = (min_x + max_x) * 0.5f;
    float center_y = (min_y + max_y) * 0.5f;
    float half_w = (max_x - min_x) * 0.5f;
    float half_h = (max_y - min_y) * 0.5f;

    int inside_count = 0;
    bool active_exit_moving_away = false;

    // Check all 3 targets
    for (int i = 0; i < 3; i++) {
      if (!targets[i].active || std::isnan(targets[i].x) || std::isnan(targets[i].y)) continue;

      float tx = targets[i].x;
      float ty = targets[i].y;

      bool is_inside = false;
      if (angle_deg == 0.0f) {
        is_inside = (tx >= min_x && tx <= max_x && ty >= min_y && ty <= max_y);
      } else {
        float dx = tx - center_x;
        float dy = ty - center_y;
        float u = 0, v = 0;
        rotate_point(dx, dy, -angle_deg, u, v);
        is_inside = (fabsf(u) <= half_w && fabsf(v) <= half_h);
      }

      if (is_inside) {
        inside_count++;
      } else if (occupied) {
        float dist_from_center = std::hypot(tx - center_x, ty - center_y);
        float zone_radius = std::hypot(half_w, half_h);

        if (dist_from_center > zone_radius) {
          if (exit_trajectory_start_ms == 0) {
            exit_trajectory_start_ms = now;
            exit_start_dist = dist_from_center;
          } else {
            if (dist_from_center >= exit_start_dist + 150.0f || (now - exit_trajectory_start_ms > 1500)) {
              active_exit_moving_away = true;
            }
          }
        }
      }
    }

    target_count = inside_count;

    if (inside_count > 0) {
      occupied = true;
      latched = false;
      last_inside_ms = now;
      exit_trajectory_start_ms = 0;
    } else {
      if (occupied) {
        uint32_t off_delay_ms = static_cast<uint32_t>(off_delay_sec * 1000.0f);
        uint32_t latch_timeout_ms = static_cast<uint32_t>(latch_timeout_min * 60.0f * 1000.0f);

        if (!vanish_protection) {
          if (now - last_inside_ms >= off_delay_ms) {
            occupied = false;
            latched = false;
            exit_trajectory_start_ms = 0;
          }
        } else {
          if (active_exit_moving_away) {
            latched = false;
            if (now - last_inside_ms >= off_delay_ms) {
              occupied = false;
              exit_trajectory_start_ms = 0;
            }
          } else {
            if (now - last_inside_ms >= latch_timeout_ms) {
              occupied = false;
              latched = false;
              exit_trajectory_start_ms = 0;
            } else {
              occupied = true;
              latched = true;
            }
          }
        }
      } else {
        latched = false;
        exit_trajectory_start_ms = 0;
      }
    }
  }
};

class RoomTracker {
 public:
  bool occupied{false};
  bool latched{false};
  int target_count{0};
  uint32_t last_seen_ms{0};
  float last_seen_dist{0};

  void update(const TargetData targets[3],
              float max_dist_mm,
              float room_x1, float room_y1, float room_x2, float room_y2,
              bool vanish_protection,
              float timeout_sec,
              float latch_timeout_min,
              float exit_margin_mm,
              bool any_zone_latched = false) {
    uint32_t now = millis();
    int count = 0;
    float closest_dist = 99999.0f;

    bool has_room_boundary = !(room_x1 == 0 && room_y1 == 0 && room_x2 == 0 && room_y2 == 0);
    float min_rx = std::min(room_x1, room_x2);
    float max_rx = std::max(room_x1, room_x2);
    float min_ry = std::min(room_y1, room_y2);
    float max_ry = std::max(room_y1, room_y2);

    for (int i = 0; i < 3; i++) {
      if (!targets[i].active || std::isnan(targets[i].dist) || targets[i].dist <= 0.0f) continue;

      bool inside_room = false;
      if (has_room_boundary) {
        if (!std::isnan(targets[i].x) && !std::isnan(targets[i].y)) {
          inside_room = (targets[i].x >= min_rx && targets[i].x <= max_rx &&
                         targets[i].y >= min_ry && targets[i].y <= max_ry);
        }
      } else {
        inside_room = (targets[i].dist <= max_dist_mm);
      }

      if (inside_room) {
        count++;
        if (targets[i].dist < closest_dist) {
          closest_dist = targets[i].dist;
        }
      }
    }

    target_count = count;

    if (count > 0) {
      occupied = true;
      latched = false;
      last_seen_ms = now;
      last_seen_dist = closest_dist;
    } else {
      if (occupied) {
        // If any configured zone is currently latched, hold room occupancy
        if (any_zone_latched) {
          occupied = true;
          latched = true;
          return;
        }

        uint32_t timeout_ms = static_cast<uint32_t>(timeout_sec * 1000.0f);
        uint32_t latch_timeout_ms = static_cast<uint32_t>(latch_timeout_min * 60.0f * 1000.0f);

        // If target exited near boundary or moved out of the room
        bool exited_boundary = false;
        if (has_room_boundary) {
          exited_boundary = true;
        } else {
          exited_boundary = (last_seen_dist >= (max_dist_mm - exit_margin_mm));
        }

        if (!vanish_protection || exited_boundary) {
          if (now - last_seen_ms >= timeout_ms) {
            occupied = false;
            latched = false;
          }
        } else {
          // Vanish protection: hold presence if target drops while stationary inside room
          if (now - last_seen_ms >= latch_timeout_ms) {
            occupied = false;
            latched = false;
          } else {
            occupied = true;
            latched = true;
          }
        }
      } else {
        latched = false;
      }
    }
  }
};

// Global state instance shared with ESPHome lambdas
static ZoneCalibrator g_calibrator;

}  // namespace presence_memory
}  // namespace esphome
