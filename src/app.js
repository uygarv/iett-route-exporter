import express from "express";
import { AppError, toErrorBody } from "./shared/errors.js";
import { createServices } from "./create-services.js";
import { summarizeCalculation, summarizeEvaluation } from "./journeys/response.js";
import { createIettHistoryService } from "./services/iett-history-service.js";
import { createIettStatisticsService } from "./services/iett-statistics-service.js";
export function createApp({ service: providedService, journeyService: providedJourneyService,
  historyService = createIettHistoryService(), statisticsService = createIettStatisticsService() } = {}) {
  const { service, journeyService } = createServices({
    service: providedService, journeyService: providedJourneyService
  });
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/iett/history/:lineCode", async (request, response, next) => {
    try {
      response.json(await historyService.getHistory(request.params.lineCode, request.query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/iett/routes/:routeCode/statistics", async (request, response, next) => {
    try {
      response.json(await statisticsService.getStatistics(request.params.routeCode, request.query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/journeys/evaluate", async (request, response, next) => {
    try {
      response.json(summarizeEvaluation(await journeyService.evaluateJourneys(request.body)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/journeys/calculate", async (request, response, next) => {
    try {
      response.json(summarizeCalculation(await journeyService.calculateJourney(request.body)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/iett/lines/:lineCode", async (request, response, next) => {
    try {
      const result = await service.getIettRouteOptions(request.params.lineCode);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/iett/routes/:routeCode/google-maps", async (request, response, next) => {
    try {
      const result = await service.buildIettGoogleMapsRoute(
        request.params.routeCode,
        request.body
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/iett/routes/:routeCode/apple-maps", async (request, response, next) => {
    try {
      const result = await service.buildIettAppleMapsRoute(
        request.params.routeCode,
        request.body
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/iett/routes/:routeCode/yandex-maps", async (request, response, next) => {
    try {
      const result = await service.buildIettYandexMapsRoute(
        request.params.routeCode,
        request.body
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/iett/routes/:routeCode/travel-times", async (request, response, next) => {
    try {
      const result = await service.calculateIettRouteTimes(
        request.params.routeCode,
        request.body
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/iett/routes/:routeCode/gpx", async (request, response, next) => {
    try {
      const result = await service.buildIettGpx(
        request.params.routeCode,
        request.query
      );

      response.set("content-type", result.contentType);
      response.set(
        "content-disposition",
        `attachment; filename="${result.filename}"`
      );
      response.send(result.gpx);
    } catch (error) {
      next(error);
    }
  });

  app.use((request, response) => {
    response.status(404).json({
      error: {
        code: "ENDPOINT_NOT_FOUND",
        message: "The requested API endpoint does not exist."
      }
    });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    let apiError = error;

    if (error instanceof SyntaxError && error.type === "entity.parse.failed") {
      apiError = new AppError(400, "INVALID_JSON", "The request body contains invalid JSON.");
    } else if (error?.type === "entity.too.large") {
      apiError = new AppError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
    }

    const { status, body } = toErrorBody(apiError);
    console.log(`Error: ${status} ${body.error.code} - ${body.error.message}`);
    response.status(status).json(body);
  });

  return app;
}
