import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const app = createApp();

app.listen(port, host, () => {
  console.log(`IETT route API listening on http://${host}:${port}`);
});
