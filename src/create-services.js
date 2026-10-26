import { IettClient } from "./clients/iett-client.js";
import { createIettService } from "./services/iett-service.js";
import { createJourneyService } from "./services/journey-service.js";

export function createServices({ client, service, journeyService } = {}) {
  if (service === undefined) {
    client ??= new IettClient();
    service = createIettService({ client });
  }
  if (journeyService === undefined) {
    journeyService = createJourneyService({ calculateBusTimes: service.calculateIettRouteTimes });
  }
  return { client, service, journeyService };
}
