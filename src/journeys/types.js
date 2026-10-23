export const StepType = Object.freeze({
  WALK: "WALK",
  METRO: "METRO",
  MBUS: "MBUS",
  BUS: "BUS",
  RING: "RING",
  BUS_OPTIONS: "BUS_OPTIONS",
  WAIT: "WAIT"
});

export const DEFAULT_RING_ROUTE = Object.freeze({
  origin: Object.freeze({ lat: 40.979940, lng: 29.128038 }),
  destination: Object.freeze({ lat: 40.974683, lng: 29.153881 })
});

export function publicError(error) {
  return {
    code: error?.code ?? "CALCULATION_FAILED",
    message: error?.code ? error.message : "The journey step could not be calculated.",
    ...(error?.details === undefined ? {} : { details: error.details })
  };
}
