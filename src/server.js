import os from "node:os";

import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const app = createApp();

const getLocalAddresses = () => Object.values(os.networkInterfaces())
  .flatMap(addresses => addresses ?? [])
  .filter(address => address.family === "IPv4" && !address.internal)
  .map(address => address.address);

app.listen(port, host, () => {
  console.log(`IETT route API listening on http://localhost:${port}`);

  for (const address of getLocalAddresses()) {
    console.log(`Network access: http://${address}:${port}`);
  }
});
