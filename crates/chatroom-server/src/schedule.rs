use chrono::{DateTime, Datelike, Days, FixedOffset, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};

pub const DEFAULT_TZ_OFFSET_MINUTES: i32 = 480; // UTC+8 (Asia/Shanghai)
pub const MIN_INTERVAL_SECONDS: u64 = 60;
pub const MAX_SCHEDULES_PER_AGENT: usize = 20;

fn default_tz_offset_minutes() -> i32 {
    DEFAULT_TZ_OFFSET_MINUTES
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentScheduleSpec {
    /// Daily (or selected weekdays `1=Mon ..= 7=Sun`) at `"HH:MM"` in `timezone_offset_minutes`
    Daily {
        daily_time: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        weekdays: Vec<u8>,
        #[serde(default = "default_tz_offset_minutes")]
        timezone_offset_minutes: i32,
    },
    /// Fixed interval in seconds (>= 60s)
    Interval {
        interval_seconds: u64,
    },
    /// One-shot trigger at Unix timestamp (ms)
    Once {
        run_at_ms: i64,
    },
    /// Standard 5-field cron expression (`min hour dom month dow`) in `timezone_offset_minutes`
    Cron {
        cron_expr: String,
        #[serde(default = "default_tz_offset_minutes")]
        timezone_offset_minutes: i32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSchedule {
    pub schedule_id: String,
    pub room_id: String,
    pub agent_id: String,
    pub title: String,
    pub task_prompt: String,
    pub spec: AgentScheduleSpec,
    pub schedule_summary: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<u64>,
    pub run_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request sent by `ragent_chatroom_extension.wasm` (`chatroom_schedule` tool)
/// to `POST /api/v1/internal/agent-schedule`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalAgentScheduleRequest {
    pub room_id: String,
    pub agent_id: String,
    /// `"create" | "list" | "update" | "pause" | "resume" | "delete"`
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_prompt: Option<String>,
    /// `"daily" | "interval" | "once" | "cron"`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone_offset_minutes: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PatchAgentScheduleRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_prompt: Option<String>,
}

pub fn format_tz_label(offset_minutes: i32) -> String {
    let sign = if offset_minutes >= 0 { '+' } else { '-' };
    let abs_m = offset_minutes.abs();
    let h = abs_m / 60;
    let m = abs_m % 60;
    if m == 0 {
        format!("UTC{sign}{h}")
    } else {
        format!("UTC{sign}{h}:{m:02}")
    }
}

pub fn format_schedule_summary(spec: &AgentScheduleSpec) -> String {
    match spec {
        AgentScheduleSpec::Daily {
            daily_time,
            weekdays,
            timezone_offset_minutes,
        } => {
            let tz = format_tz_label(*timezone_offset_minutes);
            if weekdays.is_empty() || weekdays.len() >= 7 {
                format!("每天 {daily_time} ({tz})")
            } else if weekdays == &[1, 2, 3, 4, 5] {
                format!("工作日 {daily_time} ({tz})")
            } else {
                let names: Vec<&str> = weekdays
                    .iter()
                    .map(|d| match d {
                        1 => "一",
                        2 => "二",
                        3 => "三",
                        4 => "四",
                        5 => "五",
                        6 => "六",
                        7 => "日",
                        _ => "?",
                    })
                    .collect();
                format!("每周{} {} ({})", names.join("、"), daily_time, tz)
            }
        }
        AgentScheduleSpec::Interval { interval_seconds } => {
            if *interval_seconds % 3600 == 0 {
                format!("每 {} 小时", interval_seconds / 3600)
            } else if *interval_seconds % 60 == 0 {
                format!("每 {} 分钟", interval_seconds / 60)
            } else {
                format!("每 {} 秒", interval_seconds)
            }
        }
        AgentScheduleSpec::Once { run_at_ms } => {
            let offset = FixedOffset::east_opt(DEFAULT_TZ_OFFSET_MINUTES * 60)
                .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
            if let Some(dt) = DateTime::from_timestamp_millis(*run_at_ms) {
                let local = dt.with_timezone(&offset);
                format!(
                    "单次 {} ({})",
                    local.format("%Y-%m-%d %H:%M:%S"),
                    format_tz_label(DEFAULT_TZ_OFFSET_MINUTES)
                )
            } else {
                "单次定时".to_string()
            }
        }
        AgentScheduleSpec::Cron {
            cron_expr,
            timezone_offset_minutes,
        } => {
            format!(
                "Cron `{}` ({})",
                cron_expr,
                format_tz_label(*timezone_offset_minutes)
            )
        }
    }
}

pub fn parse_schedule_spec_from_request(
    req: &InternalAgentScheduleRequest,
    now_ms: i64,
) -> Result<(AgentScheduleSpec, Option<u64>), String> {
    let kind = req
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing `kind` ('daily' | 'interval' | 'once' | 'cron')".to_string())?
        .to_ascii_lowercase();
    let tz = req
        .timezone_offset_minutes
        .unwrap_or(DEFAULT_TZ_OFFSET_MINUTES);
    if !(-720..=840).contains(&tz) {
        return Err(format!(
            "invalid timezone_offset_minutes {tz} (must be between -720 and +840)"
        ));
    }

    match kind.as_str() {
        "daily" => {
            let raw_time = req
                .daily_time
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "missing `daily_time` (expected 'HH:MM' in 24-hour format, e.g. '09:00')"
                        .to_string()
                })?;
            let (hh, mm, _) = parse_hh_mm(raw_time)?;
            let normalized_time = format!("{hh:02}:{mm:02}");
            let mut weekdays = req.weekdays.clone().unwrap_or_default();
            for &d in &weekdays {
                if !(1..=7).contains(&d) {
                    return Err(format!(
                        "invalid weekday {d} in `weekdays` (expected 1=Monday .. 7=Sunday)"
                    ));
                }
            }
            weekdays.sort_unstable();
            weekdays.dedup();
            Ok((
                AgentScheduleSpec::Daily {
                    daily_time: normalized_time,
                    weekdays,
                    timezone_offset_minutes: tz,
                },
                req.max_runs,
            ))
        }
        "interval" => {
            let secs = req.interval_seconds.ok_or_else(|| {
                "missing `interval_seconds` for kind='interval' (minimum 60)".to_string()
            })?;
            if secs < MIN_INTERVAL_SECONDS {
                return Err(format!(
                    "interval_seconds ({secs}) must be at least {MIN_INTERVAL_SECONDS} seconds"
                ));
            }
            Ok((
                AgentScheduleSpec::Interval {
                    interval_seconds: secs,
                },
                req.max_runs,
            ))
        }
        "once" => {
            let run_at_ms = if let Some(delay) = req.delay_seconds {
                if delay < 5 {
                    return Err("delay_seconds for kind='once' must be at least 5 seconds".into());
                }
                now_ms + (delay as i64) * 1000
            } else if let Some(ref once_str) = req.once_at {
                parse_once_timestamp_ms(once_str.trim(), tz)?
            } else {
                return Err(
                    "kind='once' requires either `delay_seconds` or `once_at` (ISO-8601 / 'YYYY-MM-DD HH:MM:SS')"
                        .to_string(),
                );
            };
            if run_at_ms <= now_ms {
                return Err(
                    "scheduled `once` timestamp must be in the future relative to current time"
                        .to_string(),
                );
            }
            Ok((AgentScheduleSpec::Once { run_at_ms }, Some(1)))
        }
        "cron" => {
            let expr = req
                .cron_expr
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "missing `cron_expr` for kind='cron' (expected 5-field cron 'min hour dom month dow')"
                        .to_string()
                })?;
            // Validate by parsing the 5 fields
            let _ = ParsedCron::parse(expr)?;
            Ok((
                AgentScheduleSpec::Cron {
                    cron_expr: expr.to_string(),
                    timezone_offset_minutes: tz,
                },
                req.max_runs,
            ))
        }
        other => Err(format!(
            "unsupported schedule kind '{other}' (expected 'daily', 'interval', 'once', or 'cron')"
        )),
    }
}

pub fn compute_next_run_at_ms(
    spec: &AgentScheduleSpec,
    from_ms: i64,
    run_count: u64,
    max_runs: Option<u64>,
) -> Result<Option<i64>, String> {
    if let Some(max) = max_runs {
        if run_count >= max {
            return Ok(None);
        }
    }

    match spec {
        AgentScheduleSpec::Once { run_at_ms } => {
            if run_count > 0 {
                Ok(None)
            } else {
                Ok(Some(*run_at_ms))
            }
        }
        AgentScheduleSpec::Interval { interval_seconds } => {
            let secs = (*interval_seconds).max(MIN_INTERVAL_SECONDS);
            Ok(Some(from_ms + (secs as i64) * 1000))
        }
        AgentScheduleSpec::Daily {
            daily_time,
            weekdays,
            timezone_offset_minutes,
        } => {
            let (hh, mm, ss) = parse_hh_mm(daily_time)?;
            let offset = FixedOffset::east_opt(timezone_offset_minutes * 60)
                .ok_or_else(|| "invalid timezone offset".to_string())?;
            let now_utc = DateTime::from_timestamp_millis(from_ms)
                .ok_or_else(|| "invalid current timestamp".to_string())?;
            let local_now = now_utc.with_timezone(&offset);

            for day_add in 0..=8u64 {
                let candidate_date = local_now
                    .date_naive()
                    .checked_add_days(Days::new(day_add))
                    .ok_or_else(|| "date overflow".to_string())?;
                if !weekdays.is_empty() {
                    let dow = candidate_date.weekday().number_from_monday() as u8;
                    if !weekdays.contains(&dow) {
                        continue;
                    }
                }
                let naive_dt = candidate_date
                    .and_hms_opt(hh, mm, ss)
                    .ok_or_else(|| "invalid daily_time".to_string())?;
                let candidate_local = offset
                    .from_local_datetime(&naive_dt)
                    .single()
                    .ok_or_else(|| "ambiguous local datetime".to_string())?;
                let candidate_ms = candidate_local.timestamp_millis();
                if candidate_ms > from_ms {
                    return Ok(Some(candidate_ms));
                }
            }
            Err("failed to find next matching daily schedule slot".to_string())
        }
        AgentScheduleSpec::Cron {
            cron_expr,
            timezone_offset_minutes,
        } => {
            let parsed = ParsedCron::parse(cron_expr)?;
            let offset = FixedOffset::east_opt(timezone_offset_minutes * 60)
                .ok_or_else(|| "invalid timezone offset".to_string())?;
            // Start at the next whole minute after `from_ms`
            let start_min_ms = ((from_ms / 60_000) + 1) * 60_000;
            // Search up to 366 days ahead (527,040 minutes)
            for step in 0..=527_040i64 {
                let cand_ms = start_min_ms + step * 60_000;
                let Some(utc_dt) = DateTime::from_timestamp_millis(cand_ms) else {
                    break;
                };
                let local_dt = utc_dt.with_timezone(&offset);
                if parsed.matches(&local_dt) {
                    return Ok(Some(cand_ms));
                }
            }
            Err(format!(
                "cron expression '{cron_expr}' did not match any timestamp within the next 366 days"
            ))
        }
    }
}

fn parse_hh_mm(raw: &str) -> Result<(u32, u32, u32), String> {
    let parts: Vec<&str> = raw.trim().split(':').collect();
    if parts.len() != 2 && parts.len() != 3 {
        return Err(format!(
            "invalid time '{raw}', expected 'HH:MM' (e.g. '09:00' or '18:30')"
        ));
    }
    let hh: u32 = parts[0]
        .parse()
        .map_err(|_| format!("invalid hour in '{raw}'"))?;
    let mm: u32 = parts[1]
        .parse()
        .map_err(|_| format!("invalid minute in '{raw}'"))?;
    let ss: u32 = if parts.len() == 3 {
        parts[2]
            .parse()
            .map_err(|_| format!("invalid second in '{raw}'"))?
    } else {
        0
    };
    if hh > 23 || mm > 59 || ss > 59 {
        return Err(format!("time out of range in '{raw}' (00:00..23:59)"));
    }
    Ok((hh, mm, ss))
}

fn parse_once_timestamp_ms(raw: &str, tz_offset_minutes: i32) -> Result<i64, String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.timestamp_millis());
    }
    let offset = FixedOffset::east_opt(tz_offset_minutes * 60)
        .ok_or_else(|| "invalid timezone offset".to_string())?;
    for fmt in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            if let Some(dt) = offset.from_local_datetime(&naive).single() {
                return Ok(dt.timestamp_millis());
            }
        }
    }
    Err(format!(
        "invalid `once_at` datetime '{raw}' (expected ISO-8601 like '2026-11-11T09:00:00+08:00' or '2026-11-11 09:00')"
    ))
}

struct ParsedCron {
    minutes: u64,      // 0..=59
    hours: u32,        // 0..=23
    days_of_month: u32, // 1..=31
    months: u16,       // 1..=12
    days_of_week: u8,  // 1..=7 (1=Mon .. 7=Sun)
}

impl ParsedCron {
    fn parse(expr: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!(
                "cron expression '{expr}' must have 5 space-separated fields: 'min hour dom month dow'"
            ));
        }
        let minutes = parse_cron_field_u64(fields[0], 0, 59, false)?;
        let hours = parse_cron_field_u64(fields[1], 0, 23, false)? as u32;
        let days_of_month = parse_cron_field_u64(fields[2], 1, 31, false)? as u32;
        let months = parse_cron_field_u64(fields[3], 1, 12, false)? as u16;
        let days_of_week = parse_cron_field_u64(fields[4], 0, 7, true)? as u8;
        Ok(Self {
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
        })
    }

    fn matches(&self, dt: &DateTime<FixedOffset>) -> bool {
        let min = dt.minute();
        let hr = dt.hour();
        let dom = dt.day();
        let mon = dt.month();
        let dow = dt.weekday().number_from_monday(); // 1..=7
        (self.minutes & (1u64 << min)) != 0
            && (self.hours & (1u32 << hr)) != 0
            && (self.days_of_month & (1u32 << dom)) != 0
            && (self.months & (1u16 << mon)) != 0
            && (self.days_of_week & (1u8 << dow)) != 0
    }
}

fn parse_cron_field_u64(
    field: &str,
    min_val: u32,
    max_val: u32,
    map_zero_to_seven: bool,
) -> Result<u64, String> {
    let mut mask = 0u64;
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("empty part in cron field '{field}'"));
        }
        let (range_part, step) = if let Some((r, s)) = part.split_once('/') {
            let step_val: u32 = s
                .parse()
                .map_err(|_| format!("invalid step '{s}' in cron field '{field}'"))?;
            if step_val == 0 {
                return Err(format!("step cannot be 0 in cron field '{field}'"));
            }
            (r, step_val)
        } else {
            (part, 1u32)
        };

        let (start, end) = if range_part == "*" {
            let lo = if map_zero_to_seven { 1 } else { min_val };
            (lo, max_val)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let start_v: u32 = a
                .parse()
                .map_err(|_| format!("invalid range start '{a}' in '{field}'"))?;
            let end_v: u32 = b
                .parse()
                .map_err(|_| format!("invalid range end '{b}' in '{field}'"))?;
            if start_v < min_val || end_v > max_val || start_v > end_v {
                return Err(format!(
                    "range '{range_part}' out of bounds ({min_val}..={max_val})"
                ));
            }
            (start_v, end_v)
        } else {
            let v: u32 = range_part
                .parse()
                .map_err(|_| format!("invalid value '{range_part}' in '{field}'"))?;
            if v < min_val || v > max_val {
                return Err(format!(
                    "value {v} out of bounds ({min_val}..={max_val}) in '{field}'"
                ));
            }
            (v, v)
        };

        let mut cur = start;
        while cur <= end {
            let bit_idx = if map_zero_to_seven && cur == 0 {
                7
            } else {
                cur
            };
            mask |= 1u64 << bit_idx;
            cur += step;
        }
    }
    if mask == 0 {
        return Err(format!("cron field '{field}' produced empty match set"));
    }
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daily_and_cron_schedule_next_run() {
        // 2026-11-10 08:30:00 UTC -> 16:30:00 UTC+8 (Tuesday, weekday=2)
        let base_utc = DateTime::parse_from_rfc3339("2026-11-10T08:30:00Z")
            .unwrap()
            .timestamp_millis();

        // 1. Daily at 17:00 UTC+8 should trigger same day at 09:00:00Z
        let spec_same_day = AgentScheduleSpec::Daily {
            daily_time: "17:00".to_string(),
            weekdays: vec![],
            timezone_offset_minutes: 480,
        };
        let next_ms = compute_next_run_at_ms(&spec_same_day, base_utc, 0, None)
            .unwrap()
            .unwrap();
        let next_dt = DateTime::from_timestamp_millis(next_ms).unwrap();
        assert_eq!(next_dt.to_rfc3339(), "2026-11-10T09:00:00+00:00");

        // 2. Daily at 09:00 UTC+8 (already passed today at 16:30 UTC+8) should trigger tomorrow at 01:00:00Z
        let spec_tomorrow = AgentScheduleSpec::Daily {
            daily_time: "09:00".to_string(),
            weekdays: vec![],
            timezone_offset_minutes: 480,
        };
        let next_ms2 = compute_next_run_at_ms(&spec_tomorrow, base_utc, 0, None)
            .unwrap()
            .unwrap();
        let next_dt2 = DateTime::from_timestamp_millis(next_ms2).unwrap();
        assert_eq!(next_dt2.to_rfc3339(), "2026-11-11T01:00:00+00:00");

        // 3. Cron "0 9 * * 1-5" at UTC+8 should also match 2026-11-11T01:00:00Z
        let spec_cron = AgentScheduleSpec::Cron {
            cron_expr: "0 9 * * 1-5".to_string(),
            timezone_offset_minutes: 480,
        };
        let next_ms3 = compute_next_run_at_ms(&spec_cron, base_utc, 0, None)
            .unwrap()
            .unwrap();
        assert_eq!(next_ms3, next_ms2);
    }
}
