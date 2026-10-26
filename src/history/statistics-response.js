import { shiftDate } from "./time.js";

const PERCENTILES = ["p10", "p25", "p50", "p75", "p90", "p95"];
const DAY_TYPES = ["weekday", "saturday", "sunday"];
const round = value => value == null ? null : Math.round(Number(value) * 1000) / 1000;
const rate = (count, total) => total ? Math.round(count / total * 1e6) / 1e6 : null;

export function clockStatistic(value) {
  if (value == null) return null;
  const seconds = Math.round(value);
  const day_offset = Math.floor(seconds / 86400);
  const withinDay = seconds - day_offset * 86400;
  return {
    time: [Math.floor(withinDay / 3600), Math.floor(withinDay % 3600 / 60), withinDay % 60]
      .map(part => String(part).padStart(2, "0")).join(":"),
    day_offset, seconds_from_service_midnight: round(value)
  };
}

function distribution(raw = {}, clock = false) {
  const sample_count = raw.sample_count ?? 0;
  const day_count = raw.day_count ?? 0;
  const convert = clock ? clockStatistic : round;
  const result = { sample_count, day_count, low_sample: sample_count < 20 || day_count < 3 };
  for (const key of ["mean", "min", "max"]) result[key] = convert(raw[key]);
  PERCENTILES.forEach((key, index) => { result[key] = convert(raw.percentiles?.[index]); });
  result[clock ? "stddev_seconds" : "stddev"] = round(raw.stddev);
  result[clock ? "iqr_seconds" : "iqr"] = raw.percentiles?.[3] == null ? null : round(raw.percentiles[3] - raw.percentiles[1]);
  return result;
}

function deviation(raw) {
  const result = distribution(raw);
  for (const name of ["early", "on_time", "late"]) {
    result[`${name}_count`] = raw?.[`${name}_count`] ?? 0;
    result[`${name}_rate`] = rate(result[`${name}_count`], result.sample_count);
  }
  return result;
}

function metrics(row = {}, includeArrivals) {
  const service = row.service ?? { recorded_trips: 0, day_count: 0, observed_departures: 0,
    observed_arrivals: 0, eligible_durations: 0, active_vehicles: 0, recorded_duration_seconds: 0 };
  const revision = distribution(row.plan_revision_seconds);
  for (const name of ["changed", "earlier", "later"]) {
    revision[`${name}_count`] = row.plan_revision_seconds?.[`${name}_count`] ?? 0;
    revision[`${name}_rate`] = rate(revision[`${name}_count`], revision.sample_count);
  }
  return {
    service: { ...service, low_sample: service.recorded_trips < 20 || service.day_count < 3 },
    duration_seconds: distribution(row.duration_seconds),
    ...(includeArrivals ? { arrival_time: distribution(row.arrival_time, true) } : {}),
    departure_deviation_seconds: {
      planned: deviation(row.planned_deviation_seconds), adjusted: deviation(row.adjusted_deviation_seconds)
    },
    plan_revision_seconds: revision,
    headway_seconds: distribution(row.headway_seconds)
  };
}

const EMPTY_QUALITY = { missing_start: 0, missing_end: 0, missing_both: 0, zero_duration: 0,
  negative_duration: 0, duration_over_24_hours: 0, missing_reference_departure: 0,
  reference_day_offset_anomaly: 0, excluded_duration: 0 };

function coverage(days) {
  const successful = days.filter(day => day.last_success_at != null);
  const lastSuccessful = successful.map(day => new Date(day.last_success_at).toISOString()).sort().at(-1) ?? null;
  return {
    requested_day_count: days.length, successful_day_count: successful.length,
    complete: successful.length === days.length,
    missing_dates: days.filter(day => day.last_success_at == null).map(day => day.date),
    empty_dates: days.filter(day => day.status === "empty").map(day => day.date),
    failed_dates: days.filter(day => day.status === "failed").map(day => day.date),
    no_matching_trip_dates: successful.filter(day => day.matching_records === 0).map(day => day.date),
    missing_arrival_dates: days.filter(day => day.missing_arrivals > 0)
      .map(day => ({ date: day.date, count: day.missing_arrivals })),
    last_successful_sync_at: lastSuccessful
  };
}

export function statisticsResponse(options, { groups, days, statuses }, now) {
  const specific = options.mode === "departure";
  const ofKind = kind => groups.filter(row => row.kind === kind);
  const summarize = (row, arrivals = specific) => ({ ...row.dimensions, ...metrics(row, arrivals) });
  const departures = kind => ofKind(kind).sort((a, b) =>
    (a.dimensions.weekday ?? 0) - (b.dimensions.weekday ?? 0)
    || a.dimensions.day_offset - b.dimensions.day_offset
    || a.dimensions.departure_time.localeCompare(b.dimensions.departure_time)).map(row => ({
    ...summarize(row, true),
    quality: row.quality ?? EMPTY_QUALITY
  }));
  const summary = ofKind("summary")[0];
  const weekdayRows = ofKind("weekday");
  const weekdays = options.weekday === null ? [1, 2, 3, 4, 5, 6, 7] : [options.weekday];
  const daily = new Map(ofKind("daily").map(row => [row.dimensions.record_date, row]));
  const weekly = new Map(ofKind("weekly").map(row => [row.dimensions.week_start, row]));
  const weeks = [...new Set(days.map(day => {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay() || 7;
    return shiftDate(day.date, 1 - weekday);
  }))];
  const weekdayFilter = options.weekday !== null;
  return {
    route_code: options.route_code, timezone: "Europe/Istanbul", from: options.from, to: options.to,
    mode: options.mode,
    filters: { departure_time: options.departure_time, departure_basis: options.departure_basis,
      weekday: options.weekday, departure_day_offset: options.departure_day_offset },
    generated_at: new Date(now).toISOString(),
    rules: { max_duration_seconds: 86400, on_time_tolerance_seconds: 60,
      low_sample_below: { sample_count: 20, day_count: 3 } },
    summary: { ...metrics(summary, specific), task_status_counts: statuses },
    ...(!specific ? { departures: departures("departure") } : {}),
    profiles: {
      by_weekday: weekdays.map(weekday => {
        const row = weekdayRows.find(item => item.dimensions.weekday === weekday);
        return { weekday, ...metrics(row, specific) };
      }),
      by_day_type: DAY_TYPES.filter(type => !weekdayFilter || type === (options.weekday <= 5 ? "weekday" : options.weekday === 6 ? "saturday" : "sunday"))
        .map(day_type => ({ day_type, ...metrics(ofKind("day_type").find(row => row.dimensions.day_type === day_type), specific) })),
      ...(specific ? {} : {
        by_weekday_departure: departures("weekday_departure")
      })
    },
    trends: {
      daily: days.map(day => ({ record_date: day.date, ...metrics(daily.get(day.date), specific),
        archive_available: day.last_success_at != null })),
      weekly: weeks.map(start => {
        const end = shiftDate(start, 6);
        return { week_start: start, ...metrics(weekly.get(start), specific), week_end: end,
          partial_week: start < options.from || end > options.to,
          coverage: coverage(days.filter(day => day.date >= start && day.date <= end)) };
      })
    },
    vehicles: ofKind("vehicle").map(row => ({ ...row.dimensions,
      service: metrics(row, false).service, duration_seconds: distribution(row.duration_seconds) })),
    quality: { ...(summary?.quality ?? EMPTY_QUALITY),
      scope: "matching_records",
      reference_departure_before_time_filter: {
        recorded_trips: days.reduce((sum, day) => sum + (day.route_records ?? 0), 0),
        missing_count: days.reduce((sum, day) => sum + (day.missing_reference_departures ?? 0), 0),
        day_offset_anomaly_count: days.reduce((sum, day) => sum + (day.reference_day_offset_anomalies ?? 0), 0)
      }
    },
    coverage: coverage(days)
  };
}
