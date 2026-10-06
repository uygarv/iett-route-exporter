import express from "express";
import { AppError, toErrorBody } from "./shared/errors.js";
import { createIettService } from "./services/iett-service.js";
import dotenv from "dotenv";

dotenv.config();

export function createApp({ service = createIettService() } = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (request, response) => {
    response.json({ status: "ok" });
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
    response.status(status).json(body);
  });

  return app;
}
