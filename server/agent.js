// The agent loop for one guest message.
// Sends the message to the model, runs the log_request tool when asked,
// and returns the model's final text. Also appends one row to the log.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REQUESTS_FILE = path.join(ROOT, "data", "requests.json");
const BOOKINGS_FILE = path.join(ROOT, "data", "bookings.csv");

const MODEL = "claude-sonnet-5-5";
const MAX_STEPS = 5;

// The tools the model may call.
const LOG_REQUEST_TOOL = {
  name: "log_request",
  description:
    "Records the request in the hotel's log. Call it exactly once per guest message, before your final answer.",
  input_schema: {
    type: "object",
    properties: {
      department: {
        type: "string",
        enum: [
          "Reservations",
          "Billing & Payments",
          "Front Desk & Guest Services",
          "Housekeeping & Maintenance",
          "Restaurant & Events",
          "Complaints & Feedback",
        ],
      },
      urgency: { type: "string", enum: ["high", "normal"] },
      summary: { type: "string" },
      status: { type: "string", enum: ["ANSWERED", "ESCALATED"] },
    },
    required: ["department", "urgency", "summary", "status"],
  },
};

// The model supplies no input: the backend uses the form's e-mail.
const LOOKUP_BOOKING_TOOL = {
  name: "lookup_booking",
  description:
    "Returns the guest's own reservation: dates, room type, breakfast, rate and payment status, or that no booking was found. Use it only when the answer depends on the guest's booking.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

// Read data/bookings.csv and return the row whose email matches, or {found: false}.
async function lookupBooking(email) {
  let raw;
  try {
    raw = await fs.readFile(BOOKINGS_FILE, "utf-8");
  } catch {
    return { found: false };
  }

  const lines = raw.trim().split("\n");
  if (lines.length < 2) return { found: false };

  const headers = lines[0].split(",");
  const wanted = email.trim().toLowerCase();

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row = {};
    headers.forEach((h, j) => {
      row[h] = cells[j];
    });
    if ((row.email || "").trim().toLowerCase() === wanted) {
      return row;
    }
  }

  return { found: false };
}

// Append one object to data/requests.json (a JSON array).
async function appendRequest(row) {
  let rows = [];
  try {
    const raw = await fs.readFile(REQUESTS_FILE, "utf-8");
    rows = JSON.parse(raw);
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }
  rows.push(row);
  await fs.writeFile(REQUESTS_FILE, JSON.stringify(rows, null, 2) + "\n");
}

// Run the agent loop for one guest message.
// `anthropic` is the SDK client, `systemPrompt` the full prompt with policies.
export async function runAgent({ anthropic, systemPrompt, name, email, message }) {
  const messages = [
    {
      role: "user",
      content: `Guest name: ${name}
Guest email: ${email}
Message: ${message}`,
    },
  ];

  // The four fields from the (single allowed) log_request call.
  let logged = null;
  let finalText = "";

  // One entry per step: model calls, tool calls, and the final answer.
  const trace = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      tools: [LOG_REQUEST_TOOL, LOOKUP_BOOKING_TOOL],
      messages,
    });

    const toolUses = response.content.filter((block) => block.type === "tool_use");

    // Record this model call.
    trace.push({
      kind: "model",
      step: step + 1,
      stop_reason: response.stop_reason,
      asked_for_tool: toolUses.length > 0,
    });

    // Collect any text the model produced this turn.
    const textThisTurn = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (textThisTurn) finalText = textThisTurn;

    // No tool call this turn: the model has answered with text. Stop.
    if (toolUses.length === 0) break;

    // Keep the assistant turn (text + tool_use blocks) in the history.
    messages.push({ role: "assistant", content: response.content });

    // Answer each tool call with a tool_result block.
    const toolResults = [];
    for (const toolUse of toolUses) {
      let resultText;
      if (toolUse.name === "lookup_booking") {
        // The model sends no input; the backend uses the form's e-mail.
        const booking = await lookupBooking(email);
        resultText = JSON.stringify(booking);
      } else if (toolUse.name !== "log_request") {
        resultText = "unknown tool";
      } else if (logged) {
        // At most one log_request per message.
        resultText = "already logged";
      } else {
        const input = toolUse.input || {};
        logged = {
          department: input.department,
          urgency: input.urgency,
          summary: input.summary,
          status: input.status,
        };
        resultText = JSON.stringify({ ok: true });
      }

      // Record this tool call (result cut to 200 characters).
      trace.push({
        kind: "tool",
        name: toolUse.name,
        arguments: toolUse.input || {},
        result: resultText.slice(0, 200),
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultText,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Record the final answer.
  trace.push({ kind: "final", answer: finalText });

  // Build the log row. If the model never logged, save with ESCALATED and a note.
  const row = {
    time: new Date().toISOString(),
    name,
    email,
    message,
    reply: finalText,
  };
  if (logged) {
    row.department = logged.department;
    row.urgency = logged.urgency;
    row.summary = logged.summary;
    row.status = logged.status;
  } else {
    row.department = "";
    row.urgency = "";
    row.summary = "";
    row.status = "ESCALATED";
    row.note = "no log_request call";
  }

  row.trace = trace;

  await appendRequest(row);

  return finalText;
}
