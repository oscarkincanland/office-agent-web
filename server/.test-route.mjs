import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
app.use(express.json());

app.get("/api/sessions", (_req, res) => {
  console.log("SESSION HANDLER CALLED");
  res.json({ sessions: [] });
});

const dist = "F:\\Claude code本地文件\\office-agent-web\\client\\dist";
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(3002, () => console.log("test listening on 3002"));