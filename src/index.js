import { IettClient } from "./clients/iett-client.js";
import { createIettService, parseRouteCode } from "./services/iett-service.js";

const defaultClient = new IettClient();
const defaultService = createIettService({ client: defaultClient });

export { IettClient, createIettService, parseRouteCode };

export const getIettRouteOptions = defaultService.getIettRouteOptions;
export const prepareIettLine = defaultService.prepareIettLine;
export const buildIettGoogleMapsRoute = defaultService.buildIettGoogleMapsRoute;
export const buildIettAppleMapsRoute = defaultService.buildIettAppleMapsRoute;

export function clearIettCaches() {
  defaultClient.clearCaches();
}
