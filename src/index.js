import { IettClient } from "./clients/iett-client.js";
import { TomTomClient } from "./clients/tomtom-client.js";
import { createIettService, parseRouteCode } from "./services/iett-service.js";

const defaultClient = new IettClient();
const defaultService = createIettService({ client: defaultClient });

export { IettClient, TomTomClient, createIettService, parseRouteCode };

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
