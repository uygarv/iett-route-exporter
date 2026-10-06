import { AppError } from "../shared/errors.js";
import {
  findRoutePositionCandidates,
  haversineDistance,
  pointAlongRoute
} from "./geometry.js";
import { coordinateForRouteMatch } from "./stop-projection.js";

const MAX_CANDIDATES_PER_STOP = 48;
const CANDIDATE_PROGRESS_SPACING_METERS = 15;

function stopName(stop) {
  if (!stop || typeof stop.stationName !== "string") {
    return null;
  }

  return stop.stationName.trim() || null;
}

function stopCoordinate(stop) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

function reduceCandidates(candidates) {
  const ordered = [...candidates].sort((first, second) => {
    return first.distanceToRoute - second.distanceToRoute
      || first.distanceAlongRoute - second.distanceAlongRoute;
  });
  const selected = [];

  for (const candidate of ordered) {
    if (selected.some(existing => {
      return Math.abs(existing.distanceAlongRoute - candidate.distanceAlongRoute)
        < CANDIDATE_PROGRESS_SPACING_METERS;
    })) {
      continue;
    }

    selected.push(candidate);

    if (selected.length >= MAX_CANDIDATES_PER_STOP) {
      break;
    }
  }

  return selected;
}

export function matchStopsToRoute(stops, geometry) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new AppError(
      502,
      "IETT_INVALID_STOPS",
      "The IETT route must contain at least two valid stops."
    );
  }

  const prepared = stops.map((stop, fallbackStationIndex) => {
    const stationIndex = Number.isInteger(stop?.stationIndex)
      ? stop.stationIndex
      : fallbackStationIndex;
    const name = stopName(stop);
    const coordinate = stopCoordinate(stop);

    if (!name) {
      throw new AppError(
        502,
        "IETT_INVALID_STOP_NAME",
        "An IETT stop has no usable name.",
        { stationIndex }
      );
    }

    if (!coordinate) {
      throw new AppError(
        502,
        "IETT_INVALID_STOP_COORDINATE",
        "An IETT stop has invalid coordinates.",
        { stationIndex, stationName: name }
      );
    }

    const allCandidates = findRoutePositionCandidates(geometry, coordinate);
    const candidates = reduceCandidates(allCandidates);

    if (!candidates.length) {
      throw new AppError(
        502,
        "IETT_STOP_OFF_ROUTE",
        "An IETT stop could not be projected onto the route geometry.",
        {
          stationIndex,
          stationName: name
        }
      );
    }

    return {
      name,
      coordinate,
      stationIndex,
      candidates
    };
  });

  const history = [];
  let states = prepared[0].candidates.map(candidate => ({
    candidate,
    cost: candidate.distanceToRoute ** 2,
    previousIndex: null
  }));

  history.push(states);

  for (let stopIndex = 1; stopIndex < prepared.length; stopIndex += 1) {
    const previousStates = history[stopIndex - 1];
    const nextStates = [];

    for (const candidate of prepared[stopIndex].candidates) {
      let bestPreviousIndex = null;

      for (let index = 0; index < previousStates.length; index += 1) {
        const previous = previousStates[index];

        if (previous.candidate.distanceAlongRoute >= candidate.distanceAlongRoute - 1) {
          continue;
        }

        if (
          bestPreviousIndex === null
          || previous.cost < previousStates[bestPreviousIndex].cost
        ) {
          bestPreviousIndex = index;
        }
      }

      if (bestPreviousIndex !== null) {
        nextStates.push({
          candidate,
          cost: previousStates[bestPreviousIndex].cost
            + candidate.distanceToRoute ** 2,
          previousIndex: bestPreviousIndex
        });
      }
    }

    if (!nextStates.length) {
      throw new AppError(
        502,
        "IETT_STOP_ORDER_MISMATCH",
        "IETT stops cannot be matched to the route geometry in their given order.",
        {
          stationIndex: prepared[stopIndex].stationIndex,
          stationName: prepared[stopIndex].name
        }
      );
    }

    states = nextStates;
    history.push(states);
  }

  let stateIndex = history.at(-1).reduce((bestIndex, state, index, all) => {
    return state.cost < all[bestIndex].cost ? index : bestIndex;
  }, 0);
  const chosen = new Array(prepared.length);

  for (let stopIndex = prepared.length - 1; stopIndex >= 0; stopIndex -= 1) {
    const state = history[stopIndex][stateIndex];
    chosen[stopIndex] = state.candidate;
    stateIndex = state.previousIndex;
  }

  const plausible = prepared.map(stop => {
    const nearestDistance = Math.min(...stop.candidates.map(candidate => {
      return candidate.distanceToRoute;
    }));

    return stop.candidates.map(candidate => {
      return candidate.distanceToRoute <= Math.max(nearestDistance + 15, 30);
    });
  });
  const forwardReachable = prepared.map(stop => stop.candidates.map(() => false));
  const backwardReachable = prepared.map(stop => stop.candidates.map(() => false));

  for (let index = 0; index < forwardReachable[0].length; index += 1) {
    forwardReachable[0][index] = plausible[0][index];
  }

  for (let stopIndex = 1; stopIndex < prepared.length; stopIndex += 1) {
    for (let candidateIndex = 0;
      candidateIndex < prepared[stopIndex].candidates.length;
      candidateIndex += 1) {
      const candidate = prepared[stopIndex].candidates[candidateIndex];

      forwardReachable[stopIndex][candidateIndex] = plausible[stopIndex][candidateIndex]
        && prepared[stopIndex - 1].candidates.some((previous, previousIndex) => {
          return plausible[stopIndex - 1][previousIndex]
            && forwardReachable[stopIndex - 1][previousIndex]
            && previous.distanceAlongRoute < candidate.distanceAlongRoute - 1;
        });
    }
  }

  for (let index = 0; index < backwardReachable.at(-1).length; index += 1) {
    backwardReachable.at(-1)[index] = plausible.at(-1)[index];
  }

  for (let stopIndex = prepared.length - 2; stopIndex >= 0; stopIndex -= 1) {
    for (let candidateIndex = 0;
      candidateIndex < prepared[stopIndex].candidates.length;
      candidateIndex += 1) {
      const candidate = prepared[stopIndex].candidates[candidateIndex];

      backwardReachable[stopIndex][candidateIndex] = plausible[stopIndex][candidateIndex]
        && prepared[stopIndex + 1].candidates.some((next, nextIndex) => {
          return plausible[stopIndex + 1][nextIndex]
            && backwardReachable[stopIndex + 1][nextIndex]
            && next.distanceAlongRoute > candidate.distanceAlongRoute + 1;
        });
    }
  }

  for (let stopIndex = 0; stopIndex < prepared.length; stopIndex += 1) {
    const selected = chosen[stopIndex];
    const ambiguous = prepared[stopIndex].candidates.some((candidate, candidateIndex) => {
      const similarlyClose = candidate.distanceToRoute
        <= Math.max(selected.distanceToRoute + 15, 30);
      const distantPosition = Math.abs(
        candidate.distanceAlongRoute - selected.distanceAlongRoute
      ) > 500;
      const preservesOrder = forwardReachable[stopIndex][candidateIndex]
        && backwardReachable[stopIndex][candidateIndex];

      return similarlyClose && distantPosition && preservesOrder;
    });

    if (ambiguous) {
      throw new AppError(
        502,
        "IETT_AMBIGUOUS_STOP_MATCH",
        "An IETT stop matches multiple distant positions on the route.",
        {
          stationIndex: prepared[stopIndex].stationIndex,
          stationName: prepared[stopIndex].name
        }
      );
    }
  }

  return prepared.map((stop, index) => {
    const match = chosen[index];
    const providerCoordinate = coordinateForRouteMatch(stop.coordinate, match);

    return {
      name: stop.name,
      coordinate: stop.coordinate,
      stationIndex: stop.stationIndex,
      distanceAlongRoute: match.distanceAlongRoute,
      distanceToRoute: match.distanceToRoute,
      providerCoordinate,
      projectedToRoute: providerCoordinate.lat !== stop.coordinate.lat
        || providerCoordinate.lng !== stop.coordinate.lng
    };
  });
}

export function sliceRouteGeometry(geometry, startDistance, endDistance) {
  const points = [pointAlongRoute(geometry, startDistance)];

  for (let index = 0; index < geometry.points.length; index += 1) {
    const distance = geometry.cumulativeDistances[index];

    if (distance > startDistance && distance < endDistance) {
      points.push(geometry.points[index]);
    }
  }

  points.push(pointAlongRoute(geometry, endDistance));

  const deduplicated = [];

  for (const point of points) {
    if (!deduplicated.length || haversineDistance(deduplicated.at(-1), point) >= 2) {
      deduplicated.push({ lat: point.lat, lng: point.lng });
    }
  }

  if (deduplicated.length < 2) {
    throw new AppError(
      502,
      "IETT_EMPTY_GEOMETRY",
      "The selected IETT route section is too short to process."
    );
  }

  return deduplicated;
}
