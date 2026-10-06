export function normalizeStationName(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function addStationSequenceNumbers(stops) {
  const totals = new Map();

  for (const stop of stops) {
    if (!stop.name) {
      continue;
    }

    const key = normalizeStationName(stop.name);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const occurrences = new Map();

  return stops.map(stop => {
    if (!stop.name) {
      return { ...stop };
    }

    const key = normalizeStationName(stop.name);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    const total = totals.get(key);

    occurrences.set(key, occurrence);

    if (total === 1) {
      return { ...stop };
    }

    return {
      ...stop,
      name: `${stop.name} (${occurrence})`
    };
  });
}

function withoutSequenceNumber(value) {
  return value.replace(/\s+\(\d+\)$/, "");
}

export function findStationsByName(stops, requestedName) {
  const normalized = normalizeStationName(requestedName);
  const exactMatches = stops.filter(stop => {
    return stop.name && normalizeStationName(stop.name) === normalized;
  });

  if (exactMatches.length) {
    return exactMatches;
  }

  return stops.filter(stop => {
    return stop.name
      && normalizeStationName(withoutSequenceNumber(stop.name)) === normalized;
  });
}
