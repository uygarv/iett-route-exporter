function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function coordinate(value) {
  return Number(value).toString();
}

export function buildGpxDocument({ routeCode, points, stops }) {
  const waypointLines = stops.flatMap(stop => {
    if (!stop.coordinate) {
      return [];
    }

    return [
      `  <wpt lat="${coordinate(stop.coordinate.lat)}" lon="${coordinate(stop.coordinate.lng)}">`,
      `    <name>${escapeXml(stop.name)}</name>`,
      `    <desc>IETT station ${stop.stationIndex}</desc>`,
      "    <type>IETT stop</type>",
      "  </wpt>"
    ];
  });
  const trackLines = points.map(point => {
    return `      <trkpt lat="${coordinate(point.lat)}" lon="${coordinate(point.lng)}" />`;
  });

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<gpx version=\"1.1\" creator=\"IETT route export API\" xmlns=\"http://www.topografix.com/GPX/1/1\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd\">",
    "  <metadata>",
    `    <name>${escapeXml(routeCode)}</name>`,
    "  </metadata>",
    ...waypointLines,
    "  <trk>",
    `    <name>${escapeXml(routeCode)}</name>`,
    "    <trkseg>",
    ...trackLines,
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    ""
  ].join("\n");
}
