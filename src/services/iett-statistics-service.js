import { performance } from "node:perf_hooks";
import { AppError } from "../shared/errors.js";
import { StatisticsRepository } from "../history/statistics-repository.js";
import { statisticsQuery } from "../history/statistics-query.js";
import { statisticsResponse } from "../history/statistics-response.js";

export function createIettStatisticsService({ repository = new StatisticsRepository(), clock = Date.now,
  logger = event => console.log(JSON.stringify(event)) } = {}) {
  return {
    async getStatistics(routeCode, query = {}) {
      const options = statisticsQuery(routeCode, query, clock());
      const started = performance.now();
      try {
        const result = statisticsResponse(options, await repository.read(options), clock());
        logger({ event: "iett_statistics", route_code: options.route_code, mode: options.mode,
          elapsed_ms: Math.round(performance.now() - started), sample_count: result.summary.service.recorded_trips,
          missing_day_count: result.coverage.missing_dates.length });
        return result;
      } catch (error) {
        logger({ event: "iett_statistics_error", route_code: options.route_code,
          elapsed_ms: Math.round(performance.now() - started), code: error.code ?? "UNKNOWN" });
        throw new AppError(503, error.code === "57014" ? "STATISTICS_QUERY_TIMEOUT" : "STATISTICS_DATABASE_UNAVAILABLE",
          error.code === "57014" ? "The statistics query exceeded its time limit. Try a shorter date range."
            : "Statistics storage is temporarily unavailable.");
      }
    }
  };
}
