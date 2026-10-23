/**
 * backend-mock/server.js
 * A trivial "real" service. The whole point of the project is that this
 * service never has to know rate limiting exists — it only ever sees
 * traffic that already passed the gateway + limiter.
 */
const express = require("express");
const app = express();
const PORT = process.env.PORT || 5000;

app.get("/api/data", (req, res) => {
  res.json({ message: "here is your data", servedAt: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`backend-mock listening on :${PORT}`));
