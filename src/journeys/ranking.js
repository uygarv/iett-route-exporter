export function compareCandidates(first, second) {
  return Date.parse(first.arrivalTime) - Date.parse(second.arrivalTime)
    || first.durationSeconds - second.durationSeconds
    || first.transferCount - second.transferCount
    || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}

export function selectBestCalculatedOption(options) {
  return options.filter(option => option.status === "calculated").sort(compareCandidates)[0] ?? null;
}

export function applyCurrentTime(candidate, now) {
  if (candidate.homeDepartureTime === null) return candidate;
  candidate.canStillDepart = Date.parse(candidate.homeDepartureTime) >= now;
  if (!candidate.canStillDepart) {
    candidate.reasons.push({
      code: "HOME_DEPARTURE_PASSED",
      message: "The required home departure time has already passed."
    });
    if (candidate.status === "feasible" || candidate.status === "late") candidate.status = "missed";
  }
  return candidate;
}
