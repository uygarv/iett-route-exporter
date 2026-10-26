export function archiveRecord(overrides = {}) {
  return {
    ID: 177490596, NARSIVGOREVID: 167765976, NKAYITGUNU: 20261025,
    SHATKODU: "19", SGUZERGAHKODU: "19_D_D0", SKAPINUMARA: "C-538",
    DTBASLAMAZAMANI: "/Date(1792946030000)/", DTBITISZAMANI: "/Date(1792948391000)/",
    SGOREVDURUM: "T", NGOREVID: 172359587,
    DTPLANLANANBASLANGICZAMANI: "/Date(1792945980000)/",
    DTDUZENLENENBASLANGICZAMANI: "/Date(1792945980000)/",
    ...overrides
  };
}

export function archiveXml(records = [archiveRecord()]) {
  const json = JSON.stringify(records).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetIettArsivGorev_jsonResponse xmlns="http://tempuri.org/"><GetIettArsivGorev_jsonResult>${json}</GetIettArsivGorev_jsonResult></GetIettArsivGorev_jsonResponse></soap:Body></soap:Envelope>`;
}
