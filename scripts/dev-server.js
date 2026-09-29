#!/usr/bin/env node
"use strict";

/**
 * Minimal static file server for local preview.
 *
 * Firebase Hosting rewrites /admin to /admin/index.html, but `npx serve` and
 * plain file:// do not, so this gives a quick way to click through the site
 * without deploying.
 *
 *   node scripts/dev-server.js [port]
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.argv[2]) || 8900;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, url);

    // Keep requests inside the project directory.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    // /admin -> /admin/index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(PORT, () => {
    console.log(`CRP dev server on http://localhost:${PORT}`);
    console.log(`  landing  http://localhost:${PORT}/`);
    console.log(`  sent     http://localhost:${PORT}/sent.html`);
    console.log(`  admin    http://localhost:${PORT}/admin/`);
  });
