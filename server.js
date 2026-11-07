// Hotel Estrella guest assistant - backend server.
// Serves the guest page and handles one message route.
// No framework: just Node's built-in http and file modules.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./server/agent.js";

const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const REQUESTS_FILE = path.join(__dirname, "data", "requests.json");

// The API key comes from .env (loaded by dotenv). It stays on the server.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Build the system prompt at startup: the fixed instructions, then the hotel
// policies appended as context under their own heading.
const systemPrompt = await buildSystemPrompt();

async function buildSystemPrompt() {
  const prompt = await fs.readFile(path.join(__dirname, "system-prompt.md"), "utf-8");
  const policies = await fs.readFile(path.join(__dirname, "hotel-policies.md"), "utf-8");
  return `${prompt.trim()}\n\n# Hotel policies\n\n${policies.trim()}`;
}

// Map file extensions to content types for the static files we serve.
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Read the whole request body and parse it as JSON.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// Handle POST /api/message: validate the three fields, call the model, return the reply.
async function handleMessage(req, res) {
  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Could not read your request." });
    return;
  }

  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const message = (data.message || "").trim();

  if (!name || !email || !message) {
    sendJson(res, 400, { error: "Please fill in your name, email and message." });
    return;
  }

  try {
    const reply = await runAgent({ anthropic, systemPrompt, name, email, message });
    sendJson(res, 200, { reply });
  } catch (err) {
    console.error("Agent run failed:", err.message);
    sendJson(res, 502, { error: "Sorry, we could not reach the assistant. Please try again." });
  }
}

// Handle GET /api/requests: return the log, newest first.
async function handleRequests(res) {
  let rows = [];
  try {
    const raw = await fs.readFile(REQUESTS_FILE, "utf-8");
    rows = JSON.parse(raw);
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }
  // Newest first.
  rows.reverse();
  sendJson(res, 200, rows);
}

// Serve a static file from the public directory.
async function serveStatic(req, res) {
  let urlPath = req.url;
  if (urlPath === "/") urlPath = "/index.html";
  else if (urlPath === "/staff") urlPath = "/staff.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));

  // Keep requests inside the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/message") {
    await handleMessage(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/requests") {
    await handleRequests(res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Hotel Estrella guest assistant running at http://localhost:${PORT}`);
});
