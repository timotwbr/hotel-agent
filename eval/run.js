// eval/run.js - run the hotel assistant over eval/cases.csv and grade each case.
//
// For every row in cases.csv we run the agent on the guest message, with the
// log_request tool STUBBED: nothing is written to data/requests.json, and the
// trace records "stubbed" for that call. We then ask the model to grade the
// output against the rubric and the hotel policies, using the API's structured
// output (a forced tool whose JSON schema fixes the shape: a score of 1-5 and a
// one-sentence reason). Results go to eval/results/<date>-<time>.md and stdout.
//
// This file does not touch server/agent.js or any data file; it mirrors the
// agent loop locally so the real log stays untouched.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CASES_FILE = path.join(__dirname, "cases.csv");
const RUBRIC_FILE = path.join(__dirname, "rubric.md");
const POLICIES_FILE = path.join(ROOT, "hotel-policies.md");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "system-prompt.md");
const BOOKINGS_FILE = path.join(ROOT, "data", "bookings.csv");
const RESULTS_DIR = path.join(__dirname, "results");

const MODEL = "claude-sonnet-5-5";
const MAX_STEPS = 5;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- The agent's tools (same shapes as server/agent.js) --------------------

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

const LOOKUP_BOOKING_TOOL = {
  name: "lookup_booking",
  description:
    "Returns the guest's own reservation: dates, room type, breakfast, rate and payment status, or that no booking was found. Use it only when the answer depends on the guest's booking.",
  input_schema: { type: "object", properties: {} },
};

// Read data/bookings.csv and return the row whose email matches, or {found:false}.
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
    if ((row.email || "").trim().toLowerCase() === wanted) return row;
  }
  return { found: false };
}

// --- Run the agent for one case, with log_request stubbed ------------------
// Returns { finalText, logged, trace, toolResults } where toolResults holds
// every tool call and the value we returned to the model.
async function runAgentStubbed({ systemPrompt, name, email, message }) {
  const messages = [
    {
      role: "user",
      content: `Guest name: ${name}\nGuest email: ${email}\nMessage: ${message}`,
    },
  ];

  let logged = null; // the four fields the model tried to log (even if stubbed)
  let finalText = "";
  const trace = [];
  const toolResults = []; // full record of tool calls + results

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      tools: [LOG_REQUEST_TOOL, LOOKUP_BOOKING_TOOL],
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    trace.push({
      kind: "model",
      step: step + 1,
      stop_reason: response.stop_reason,
      asked_for_tool: toolUses.length > 0,
    });

    const textThisTurn = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (textThisTurn) finalText = textThisTurn;

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const results = [];
    for (const toolUse of toolUses) {
      let resultText;
      if (toolUse.name === "lookup_booking") {
        const booking = await lookupBooking(email);
        resultText = JSON.stringify(booking);
      } else if (toolUse.name === "log_request") {
        // STUBBED: do not write to data/requests.json. Record the intent,
        // and tell the model it was logged so the loop proceeds as normal.
        const input = toolUse.input || {};
        logged = {
          department: input.department,
          urgency: input.urgency,
          summary: input.summary,
          status: input.status,
        };
        resultText = JSON.stringify({ ok: true });
      } else {
        resultText = "unknown tool";
      }

      const entry = {
        kind: "tool",
        name: toolUse.name,
        arguments: toolUse.input || {},
        result: toolUse.name === "log_request" ? "stubbed (not written to data/requests.json)" : resultText,
      };
      trace.push(entry);
      toolResults.push(entry);

      results.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
    }

    messages.push({ role: "user", content: results });
  }

  trace.push({ kind: "final", answer: finalText });
  return { finalText, logged, trace, toolResults };
}

// --- The grade schema: structured output enforced by the API --------------
// We use the Messages API's structured-output feature (output_config.format
// with type "json_schema"). The schema is compiled into a grammar constraint,
// so the model's reply is guaranteed to match it: it is not merely asked for
// in the prompt text. The JSON lands in the response's text content block.

const GRADE_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        enum: [1, 2, 3, 4, 5],
        description: "1, 3 or 5 per the rubric (2 and 4 allowed in between).",
      },
      sentence: { type: "string", description: "One sentence explaining the score." },
    },
    required: ["score", "sentence"],
    additionalProperties: false,
  },
};

async function gradeCase({ rubric, policies, row, run }) {
  const status = run.logged ? run.logged.status : "(none logged)";
  const toolResultsText = run.toolResults.length
    ? run.toolResults
        .map((t) => `- ${t.name}(${JSON.stringify(t.arguments)}) -> ${t.result}`)
        .join("\n")
    : "(no tool calls)";

  const userText = `${rubric.trim()}

# Hotel policies

${policies.trim()}

# The case

Guest name: ${row.name}
Guest email: ${row.email}
Guest message: ${row.message}

Expected behaviour: ${row.expected}

# The assistant's output

Logged fields:
- department: ${run.logged ? run.logged.department : "(none)"}
- urgency: ${run.logged ? run.logged.urgency : "(none)"}
- summary: ${run.logged ? run.logged.summary : "(none)"}
- status: ${status}

Final reply to the guest:
${run.finalText}

Full tool results:
${toolResultsText}

Return your score and one sentence.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: userText }],
    output_config: { format: GRADE_FORMAT }, // structured output: schema-constrained
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  try {
    const parsed = JSON.parse(text);
    return { score: parsed.score, sentence: parsed.sentence };
  } catch {
    return { score: null, sentence: `Could not parse grade: ${text.slice(0, 120)}` };
  }
}

// --- Markdown helpers ------------------------------------------------------

// Replace line breaks with spaces and escape pipes so a cell stays one cell.
function cell(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTable(results) {
  const header = "| id | message | expected | outcome | score | sentence |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const lines = results.map((r) => {
    const statusText = r.run.logged ? r.run.logged.status : "(none logged)";
    const outcome = `${statusText}: ${r.run.finalText}`;
    return `| ${cell(r.row.id)} | ${cell(r.row.message)} | ${cell(r.row.expected)} | ${cell(outcome)} | ${cell(r.grade.score)} | ${cell(r.grade.sentence)} |`;
  });
  return [header, sep, ...lines].join("\n");
}

// Date and time for the file name: YYYY-MM-DD-HHMMSS (local time).
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${date}-${time}`;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const [rubric, policies, systemPromptText, policiesForPrompt, casesRaw] = await Promise.all([
    fs.readFile(RUBRIC_FILE, "utf-8"),
    fs.readFile(POLICIES_FILE, "utf-8"),
    fs.readFile(SYSTEM_PROMPT_FILE, "utf-8"),
    fs.readFile(POLICIES_FILE, "utf-8"),
    fs.readFile(CASES_FILE, "utf-8"),
  ]);

  const systemPrompt = `${systemPromptText.trim()}\n\n# Hotel policies\n\n${policiesForPrompt.trim()}`;

  const rows = parse(casesRaw, { columns: true, skip_empty_lines: true });

  // Run and grade all six cases at the same time.
  const results = await Promise.all(
    rows.map(async (row) => {
      const run = await runAgentStubbed({
        systemPrompt,
        name: row.name,
        email: row.email,
        message: row.message,
      });
      const grade = await gradeCase({ rubric, policies, row, run });
      return { row, run, grade };
    })
  );

  // Keep the original case order (ascending id) in the table.
  results.sort((a, b) => Number(a.row.id) - Number(b.row.id));

  const table = buildTable(results);

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${stamp()}.md`);
  const doc = `# Eval run ${stamp()}\n\n${table}\n`;
  await fs.writeFile(outFile, doc);

  console.log(doc);
  console.log(`\nWritten to ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
