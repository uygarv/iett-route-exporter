import { IettClient } from "./clients/iett-client.js";
import { TomTomClient } from "./clients/tomtom-client.js";
import { createIettService, parseRouteCode } from "./services/iett-service.js";
import { createJourneyService } from "./services/journey-service.js";
import { createServices } from "./create-services.js";

const { client: defaultClient, service: defaultService, journeyService: defaultJourneyService } = createServices();

export { IettClient, TomTomClient, createIettService, parseRouteCode };
export { createTomTomScheduler } from "./clients/tomtom-scheduler.js";
export { HereClient, createHereScheduler } from "./clients/here-client.js";
export { DEFAULT_GEOMETRY_POLICY } from "./routing/geometry-match.js";
export { createJourneyService };
export { DEFAULT_SCORING_WEIGHTS } from "./journeys/scoring.js";
export { StepType, DEFAULT_RING_ROUTE } from "./journeys/types.js";
export const evaluateJourneys = defaultJourneyService.evaluateJourneys;
export const calculateJourney = defaultJourneyService.calculateJourney;

export const getIettRouteOptions = defaultService.getIettRouteOptions;
export const prepareIettLine = defaultService.prepareIettLine;
export const buildIettGoogleMapsRoute = defaultService.buildIettGoogleMapsRoute;
export const buildIettAppleMapsRoute = defaultService.buildIettAppleMapsRoute;
export const buildIettYandexMapsRoute = defaultService.buildIettYandexMapsRoute;
export const buildIettGpx = defaultService.buildIettGpx;
export const calculateIettRouteTimes = defaultService.calculateIettRouteTimes;

export function clearIettCaches() {
  defaultClient.clearCaches();
  defaultService.clearCaches();
}
