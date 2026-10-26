import assert from "node:assert/strict";
import { StatisticsRepository } from "../../src/history/statistics-repository.js";
import { createIettStatisticsService } from "../../src/services/iett-statistics-service.js";
import { archiveRecord } from "./iett-archive.js";

const clock = () => Date.parse("2026-10-26T12:00:00Z");
const range = { from: "2026-10-19", to: "2026-10-25" };

function trip(date, id, options = {}) {
  const { route = "R_D_D0", vehicle = "BUS-1", planned = "07:55:00", adjusted = planned,
    start = "07:55:00", end = "08:55:00", status = "T" } = options;
  const timestamp = value => {
    if (value == null) return null;
    const time = Date.parse(`${value.includes("T") ? value : `${date}T${value}`}+03:00`);
    return Number.isFinite(time) ? `/Date(${time})/` : value;
  };
  return archiveRecord({ ID: id, NKAYITGUNU: Number(date.replaceAll("-", "")),
    SHATKODU: "R", SGUZERGAHKODU: route, SKAPINUMARA: vehicle, SGOREVDURUM: status,
    DTPLANLANANBASLANGICZAMANI: timestamp(planned), DTDUZENLENENBASLANGICZAMANI: timestamp(adjusted),
    DTBASLAMAZAMANI: timestamp(start), DTBITISZAMANI: timestamp(end) });
}

export async function testStatisticsPostgres(t, database, historyRepository, reset) {
  const service = createIettStatisticsService({ repository: new StatisticsRepository(database), clock, logger: () => {} });
  const read = (query = {}, route = "R_D_D0") => service.getStatistics(route, { ...range, ...query });
  const load = async entries => historyRepository.withIngestionLock(async locked => {
    await locked.enqueueRange(range.from, range.to);
    for (const [date, records] of entries) await locked.saveDay(date, records);
  });

  await t.test("statistics route index replaces the redundant line/route index", async () => {
    const indexes = (await database.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='iett_history_trips'")).rows;
    assert.ok(indexes.some(row => row.indexname === "iett_history_trips_route_date_idx"
      && row.indexdef.includes("(route_code, record_date DESC, source_id DESC)")));
    assert.ok(indexes.some(row => row.indexname === "iett_history_trips_line_date_idx"));
    assert.ok(!indexes.some(row => row.indexname === "iett_history_trips_line_route_date_idx"));
  });

  await t.test("specific departure selects the original planned minute, independent of actual lateness and status", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [
      trip(date, 1, { start: "08:02:20", end: "09:01:00", adjusted: "08:00:00", status: "NEW_STATUS" }),
      trip(date, 2, { planned: "07:55:59", start: "07:56:00", end: "08:30:00" }),
      trip(date, 3, { planned: "07:54:59" }), trip(date, 4, { planned: "07:56:00" }),
      trip(date, 5, { route: "R_G_D0" }), trip(date, 6, { route: "R_D_D0(2)" })
    ]]]);
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.summary.service.recorded_trips, 2);
    assert.equal(result.summary.duration_seconds.sample_count, 2);
    assert.equal(result.summary.arrival_time.p50.time, "08:45:30");
    assert.deepEqual(result.summary.task_status_counts, [{ task_status: "NEW_STATUS", count: 1 }, { task_status: "T", count: 1 }]);
    assert.equal(result.profiles.by_weekday.find(day => day.weekday === 1).service.recorded_trips, 2);
    assert.ok(!Object.hasOwn(result, "departures"));
    assert.equal((await read({ departure_time: "08:00", departure_basis: "adjusted" })).summary.service.recorded_trips, 1);
    assert.equal((await read({ departure_time: "08:02", departure_basis: "actual" })).summary.service.recorded_trips, 1);
    const near = await read({ departure_time: "07:53" });
    assert.equal(near.summary.service.recorded_trips, 0);
    assert.equal(near.summary.arrival_time.mean, null);
    assert.deepEqual(near.coverage.no_matching_trip_dates, [date]);
    assert.equal(near.trends.weekly[0].service.recorded_trips, 0);
    assert.equal((await read({}, "UNKNOWN")).summary.service.recorded_trips, 0);
    assert.equal((await read({}, "R_G_D0")).summary.service.recorded_trips, 1);
  });

  await t.test("general queries calculate every original planned minute separately and match exact-departure queries", async () => {
    await reset();
    const first = "2026-10-19", second = "2026-10-20", sunday = "2026-10-25";
    await load([[first, [
      trip(first, 1, { planned: "07:35:00", adjusted: "08:00:00", start: "08:02:00", end: "09:01:00" }),
      trip(first, 2, { planned: "07:40:00", start: "07:43:00", end: "08:43:00" }),
      trip(first, 3, { planned: "07:35:59", start: "07:36:00", end: "08:30:00" }),
      trip(first, 4, { planned: "08:05:00", start: "08:05:00", end: "09:05:00" }),
      trip(first, 5, { planned: null }), trip(first, 6, { planned: "unparseable" })
    ]], [second, [
      trip(second, 1, { planned: "07:35:00", start: "07:35:00", end: "08:55:00" }),
      trip(second, 2, { planned: "07:40:00", end: null }),
      trip(second, 3, { planned: "23:20:00", start: "23:20:00", end: "2026-10-21T00:20:00" })
    ]], [sunday, [trip(sunday, 1, { planned: "09:00:00" })]]]);
    const general = await read();
    assert.deepEqual(general.departures.map(row => row.departure_time), ["07:35", "07:40", "08:05", "09:00", "23:20"]);
    assert.equal(general.summary.service.recorded_trips, 10);
    assert.equal(general.departures.reduce((sum, row) => sum + row.service.recorded_trips, 0), 8);
    assert.equal(general.quality.missing_reference_departure, 2);
    assert.equal(general.departures[0].service.recorded_trips, 3);
    assert.equal(general.departures[0].service.day_count, 2);
    assert.equal(general.departures[0].arrival_time.p50.time, "08:55:00");
    assert.equal(general.departures[1].arrival_time.sample_count, 1);
    assert.equal(general.departures[1].quality.missing_end, 1);
    assert.equal(general.departures.at(-1).arrival_time.p50.day_offset, 1);
    for (const row of general.departures) {
      const exact = await read({ departure_time: row.departure_time, departure_day_offset: String(row.day_offset) });
      for (const key of ["service", "duration_seconds", "arrival_time", "departure_deviation_seconds", "plan_revision_seconds", "headway_seconds"]) {
        assert.deepEqual(row[key], exact.summary[key], `${row.departure_time}: ${key}`);
      }
      for (const [key, value] of Object.entries(row.quality)) assert.equal(value, exact.quality[key]);
    }
    const monday = await read({ weekday: "1" });
    assert.deepEqual(monday.departures.map(row => row.departure_time), ["07:35", "07:40", "08:05"]);
    assert.equal(monday.departures[0].service.recorded_trips, 2);
    assert.equal(general.profiles.by_weekday_departure.find(row => row.weekday === 1 && row.departure_time === "07:35").service.recorded_trips, 2);
    const singleDay = await read({ from: second, to: second });
    assert.deepEqual(singleDay.departures.map(row => row.departure_time), ["07:35", "07:40", "23:20"]);
    assert.ok(singleDay.departures.every(row => row.service.day_count === 1 && row.service.recorded_trips === 1));
    assert.deepEqual((await read({ weekday: "7" })).departures.map(row => row.departure_time), ["09:00"]);
  });

  await t.test("headways use adjacent actual departures before time filtering and reset each service day", async () => {
    await reset();
    const date = "2026-10-19", next = "2026-10-20";
    await load([[date, [trip(date, 1, { planned: "07:35:00", start: "07:35:00" }),
      trip(date, 2), trip(date, 3, { planned: "08:10:00", start: "08:10:00" }),
      trip(date, 4, { planned: null, start: null }), trip(date, 5, { route: "R_G_D0", start: "07:54:00" })]],
    [next, [trip(next, 6)]]]);
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.summary.service.recorded_trips, 2);
    assert.equal(result.summary.headway_seconds.sample_count, 1);
    assert.equal(result.summary.headway_seconds.p50, 1200);
    const general = await read();
    assert.equal(general.summary.headway_seconds.sample_count, 2);
    assert.equal(general.summary.headway_seconds.mean, 1050);
    const monday = await read({ weekday: "1", departure_time: "07:55" });
    assert.equal(monday.summary.headway_seconds.mean, 1200);
    assert.equal(monday.coverage.requested_day_count, 1);
    assert.deepEqual(monday.profiles.by_weekday.map(day => day.weekday), [1]);
  });

  await t.test("equal actual starts have deterministic zero headways rather than fabricated gaps", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1, { planned: "07:35:00" }), trip(date, 2)]]]);
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.summary.headway_seconds.sample_count, 1);
    assert.equal(result.summary.headway_seconds.min, 0);
  });

  await t.test("arrival averages and percentiles cross midnight using seconds from service midnight", async () => {
    await reset();
    await load([["2026-10-19", [trip("2026-10-19", 1, { planned: "23:00:00", start: "23:00:00", end: "23:55:00" })]],
      ["2026-10-20", [trip("2026-10-20", 2, { planned: "23:00:00", start: "23:00:00", end: "2026-10-21T00:05:00" })]]]);
    const result = await read({ departure_time: "23:00" });
    assert.equal(result.summary.arrival_time.mean.time, "00:00:00");
    assert.equal(result.summary.arrival_time.mean.day_offset, 1);
    assert.equal(result.summary.arrival_time.mean.seconds_from_service_midnight, 86400);
    assert.equal(result.summary.arrival_time.min.day_offset, 0);
    assert.equal(result.summary.arrival_time.max.day_offset, 1);
    assert.equal(result.summary.duration_seconds.mean, 3600);
    assert.equal(result.summary.arrival_time.p90.seconds_from_service_midnight, 86640);
  });

  await t.test("service-day and next-day departures stay separate, and weekday uses the service date", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1, { planned: "00:30:00", start: "00:30:00", end: "01:10:00" }),
      trip(date, 2, { planned: "2026-10-20T00:30:00", start: "2026-10-20T00:30:00", end: "2026-10-20T01:10:00" }),
      trip(date, 3, { planned: "2026-10-18T00:30:00" }), trip(date, 4, { planned: "2027-10-19T00:30:00" }),
      trip(date, 5, { planned: null })]]]);
    const general = await read();
    assert.deepEqual(general.departures.map(row => row.day_offset), [0, 1]);
    assert.ok(general.departures.every(row => row.departure_time === "00:30"));
    assert.ok(general.departures.every(row => row.arrival_time.sample_count === 1));
    assert.equal(general.quality.reference_day_offset_anomaly, 2);
    assert.equal(general.quality.missing_reference_departure, 1);
    const nextDay = await read({ departure_time: "00:30", departure_day_offset: "1", weekday: "1" });
    assert.equal(nextDay.summary.service.recorded_trips, 1);
    assert.equal(nextDay.summary.arrival_time.p50.day_offset, 1);
    assert.equal(nextDay.summary.arrival_time.p50.time, "01:10:00");
    assert.equal(nextDay.quality.reference_departure_before_time_filter.day_offset_anomaly_count, 2);
    assert.equal((await read({ departure_time: "00:30" })).summary.service.recorded_trips, 1);
    assert.equal((await read({ departure_time: "00:30", weekday: "2" })).summary.service.recorded_trips, 0);
  });

  await t.test("duration and arrival quality exclude missing, zero, negative and over-24-hour tasks", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1), trip(date, 2, { start: null }), trip(date, 3, { end: null }),
      trip(date, 4, { start: null, end: null }), trip(date, 5, { end: "07:55:00" }),
      trip(date, 6, { end: "07:54:00" }), trip(date, 7, { end: "2026-10-20T07:55:01" }),
      trip(date, 8, { end: "2026-10-20T07:55:00", status: "UNRECOGNIZED" }),
      trip(date, 9, { end: "unparseable" })]]]);
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.summary.service.recorded_trips, 9);
    assert.equal(result.summary.duration_seconds.sample_count, 2);
    assert.equal(result.summary.arrival_time.sample_count, 2);
    assert.equal(result.summary.duration_seconds.max, 86400);
    assert.equal(result.summary.duration_seconds.mean, 45000);
    assert.equal(result.summary.service.observed_arrivals, 6);
    assert.equal(result.quality.missing_start, 2);
    assert.equal(result.quality.missing_end, 3);
    assert.equal(result.quality.missing_both, 1);
    assert.equal(result.quality.zero_duration, 1);
    assert.equal(result.quality.negative_duration, 1);
    assert.equal(result.quality.duration_over_24_hours, 1);
    assert.equal(result.quality.excluded_duration, 7);
    assert.equal(result.vehicles[0].service.recorded_duration_seconds, 90000);
    assert.deepEqual(result.coverage.missing_arrival_dates, [{ date, count: 3 }]);
  });

  await t.test("on-time rates include exactly +/-60 seconds and revisions use both plans", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1, { start: "07:54:00" }), trip(date, 2, { start: "07:56:00" }),
      trip(date, 3, { start: "07:53:59", adjusted: "07:50:00" }),
      trip(date, 4, { start: "07:56:01", adjusted: "08:00:00" }),
      trip(date, 5, { start: null, adjusted: null })]]]);
    const result = await read({ departure_time: "07:55" });
    const planned = result.summary.departure_deviation_seconds.planned;
    assert.equal(planned.sample_count, 4);
    assert.equal(planned.early_count, 1);
    assert.equal(planned.on_time_count, 2);
    assert.equal(planned.late_count, 1);
    assert.equal(planned.early_rate, 0.25);
    assert.equal(planned.on_time_rate, 0.5);
    const revisions = result.summary.plan_revision_seconds;
    assert.equal(revisions.sample_count, 4);
    assert.equal(revisions.changed_count, 2);
    assert.equal(revisions.changed_rate, 0.5);
    assert.equal(revisions.earlier_count, 1);
    assert.equal(revisions.later_count, 1);
    assert.equal(revisions.min, -300);
    assert.equal(revisions.max, 300);
    assert.equal(result.summary.departure_deviation_seconds.adjusted.sample_count, 4);
  });

  await t.test("coverage distinguishes unavailable days, no matching minute, and missing arrivals; refresh failures preserve coverage", async () => {
    await reset();
    await load([["2026-10-19", [trip("2026-10-19", 1, { end: null })]],
      ["2026-10-20", [trip("2026-10-20", 2, { planned: "08:00:00" })]],
      ["2026-10-21", [trip("2026-10-21", 3)]]]);
    await database.query("UPDATE iett_history_import_days SET status='failed',last_error='refresh failed' WHERE record_date='2026-10-21'");
    await database.query("UPDATE iett_history_import_days SET status='empty' WHERE record_date='2026-10-22'");
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.successful_day_count, 3);
    assert.deepEqual(result.coverage.no_matching_trip_dates, ["2026-10-20"]);
    assert.deepEqual(result.coverage.missing_dates, ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    assert.deepEqual(result.coverage.failed_dates, ["2026-10-21"]);
    assert.deepEqual(result.coverage.empty_dates, ["2026-10-22"]);
    assert.deepEqual(result.coverage.missing_arrival_dates, [{ date: "2026-10-19", count: 1 }]);
    assert.equal(result.trends.daily.find(day => day.record_date === "2026-10-20").archive_available, true);
    assert.equal(result.trends.daily.find(day => day.record_date === "2026-10-22").archive_available, false);
  });

  await t.test("weekly distributions aggregate observations directly and distinct vehicle counts are not summed", async () => {
    await reset();
    const first = "2026-10-19", second = "2026-10-20";
    await load([[first, [trip(first, 1, { end: "07:56:00", vehicle: "BUS-A" }),
      trip(first, 2, { end: "07:56:00", vehicle: "BUS-B" }), trip(first, 3, { end: "07:56:00", vehicle: "BUS-A" })]],
    [second, [trip(second, 4, { end: "08:55:00", vehicle: "BUS-A" })]]]);
    const result = await read();
    assert.equal(result.trends.weekly.length, 1);
    assert.equal(result.trends.weekly[0].duration_seconds.p50, 60);
    assert.equal(result.summary.duration_seconds.mean, 945);
    assert.equal(result.summary.service.active_vehicles, 2);
    assert.equal(result.vehicles.find(row => row.vehicle_door_number === "BUS-A").service.day_count, 2);
    assert.equal(result.vehicles.find(row => row.vehicle_door_number === "BUS-A").service.recorded_duration_seconds, 3720);
    assert.equal(result.trends.weekly[0].partial_week, false);
    const partial = await read({ from: second, to: "2026-10-21" });
    assert.equal(partial.trends.weekly[0].partial_week, true);
    assert.equal(partial.trends.weekly[0].coverage.requested_day_count, 2);
    assert.equal(partial.trends.weekly[0].coverage.successful_day_count, 1);
    assert.equal(result.profiles.by_weekday_departure.length, 2);
    assert.ok(!Object.hasOwn(result.summary, "arrival_time"));
  });

  await t.test("each metric applies its own sample size and distinct-day threshold", async () => {
    await reset();
    const dates = ["2026-10-19", "2026-10-20", "2026-10-21"];
    const entries = dates.map((date, day) => [date, Array.from({ length: day === 2 ? 6 : 7 }, (_, index) =>
      trip(date, day * 10 + index, { end: index === 0 ? null : "08:55:00" }))]);
    await load(entries);
    const result = await read({ departure_time: "07:55" });
    assert.equal(result.summary.service.recorded_trips, 20);
    assert.equal(result.summary.service.low_sample, false);
    assert.equal(result.summary.arrival_time.sample_count, 17);
    assert.equal(result.summary.arrival_time.day_count, 3);
    assert.equal(result.summary.arrival_time.low_sample, true);
    assert.ok(result.profiles.by_weekday.every(row => row.duration_seconds.low_sample));
    await database.query("UPDATE iett_history_trips SET ended_at = started_at + interval '1 hour'");
    assert.equal((await read()).summary.duration_seconds.low_sample, false);
    assert.equal((await read({ to: "2026-10-20" })).summary.duration_seconds.low_sample, true);
    await load([[dates[0], Array.from({ length: 20 }, (_, id) => trip(dates[0], id))]]);
    const oneDay = await read({ from: dates[0], to: dates[0] });
    assert.equal(oneDay.summary.duration_seconds.sample_count, 20);
    assert.equal(oneDay.summary.duration_seconds.day_count, 1);
    assert.equal(oneDay.summary.duration_seconds.low_sample, true);
  });

  await t.test("Unicode and mixed-case route names match exactly without online route lookup", async () => {
    await reset();
    const date = "2026-10-19", route = "THSS_G_DGR_Ümraniye(2)";
    await load([[date, [trip(date, 1, { route }), trip(date, 2, { route: route.toUpperCase() })]]]);
    const result = await read({}, route);
    assert.equal(result.route_code, route);
    assert.equal(result.summary.service.recorded_trips, 1);
    assert.equal((await read({}, `${route}' OR 1=1 --`)).summary.service.recorded_trips, 0);
  });

  await t.test("summary, coverage and statuses use the same snapshot during a concurrent correction", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1)]]]);
    const snapshotRepository = new StatisticsRepository({ connect: async () => {
      const client = await database.connect();
      return {
        release: () => client.release(),
        query: async (...args) => {
          const result = await client.query(...args);
          if (args[0].includes("GROUP BY GROUPING SETS")) {
            await database.query("UPDATE iett_history_trips SET ended_at=NULL, task_status='CORRECTED'");
            await database.query("UPDATE iett_history_import_days SET status='failed',last_success_at=NULL");
          }
          return result;
        }
      };
    } });
    const snapshotService = createIettStatisticsService({ repository: snapshotRepository, clock, logger: () => {} });
    const result = await snapshotService.getStatistics("R_D_D0", { from: date, to: date });
    assert.equal(result.summary.service.eligible_durations, 1);
    assert.equal(result.coverage.complete, true);
    assert.deepEqual(result.coverage.missing_arrival_dates, []);
    assert.deepEqual(result.summary.task_status_counts, [{ task_status: "T", count: 1 }]);
    const after = await read({ from: date, to: date });
    assert.equal(after.coverage.complete, false);
    assert.equal(after.summary.service.eligible_durations, 0);
  });

  await t.test("PostgreSQL statement cancellation becomes 503 and leaves the pool usable", async () => {
    await reset();
    const date = "2026-10-19";
    await load([[date, [trip(date, 1)]]]);
    const timedRepository = new StatisticsRepository({ connect: async () => {
      const client = await database.connect();
      return {
        release: () => client.release(),
        query: async (sql, ...args) => {
          if (sql.startsWith("SET LOCAL statement_timeout")) return client.query("SET LOCAL statement_timeout = '10ms'");
          // Leave ample room for OS timer scheduling under the full parallel suite.
          if (sql.startsWith("WITH")) await client.query("SELECT pg_sleep(1)");
          return client.query(sql, ...args);
        }
      };
    } });
    const timedService = createIettStatisticsService({ repository: timedRepository, clock, logger: () => {} });
    await assert.rejects(timedService.getStatistics("R_D_D0", { from: date, to: date }),
      { status: 503, code: "STATISTICS_QUERY_TIMEOUT" });
    assert.equal((await read({ from: date, to: date })).summary.service.recorded_trips, 1);
  });
}
