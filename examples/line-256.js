import {
  buildIettAppleMapsRoute,
  buildIettGoogleMapsRoute,
  getIettRouteOptions
} from "../src/index.js";

function currentLocationFromEnvironment() {
  if (!process.env.CURRENT_LAT || !process.env.CURRENT_LNG) {
    return null;
  }

  return {
    lat: Number(process.env.CURRENT_LAT),
    lng: Number(process.env.CURRENT_LNG)
  };
}

async function main() {
  const lineCode = "256";
  const routeOptions = await getIettRouteOptions(lineCode);

  const variants = routeOptions.directions.flatMap(direction => direction.variants);
  const selectedVariant = variants.find(variant => variant.code === "256_G_D0");

  if (!selectedVariant) {
    console.log("IETT does not currently list 256_G_D0 for line 256.");
    console.log(JSON.stringify(routeOptions, null, 2));
    return;
  }

  const buildOptions = { maxWaypoints: 9 };
  const currentLocation = currentLocationFromEnvironment();

  if (currentLocation) {
    buildOptions.currentLocation = currentLocation;
  }

  const googleResult = await buildIettGoogleMapsRoute(selectedVariant.code, buildOptions);
  const appleResult = await buildIettAppleMapsRoute(selectedVariant.code, {
    ...buildOptions,
    maxWaypoints: 13
  });

  console.log(`${lineCode} → ${selectedVariant.code}`);
  console.log(`Google Maps: ${googleResult.url}`);
  console.log(`Apple Maps: ${appleResult.url}`);
}

main().catch(error => {
  if (error.code === "IETT_LINE_NOT_FOUND") {
    console.error("IETT currently returns no discoverable routes for line 256.");
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
