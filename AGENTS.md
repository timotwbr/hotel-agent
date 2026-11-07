# AGENTS.md: Hotel Estrella guest assistant

## Project
A web page where hotel guests send a message (name, e-mail, message) and get an answer from the hotel's policies, or are told that staff will reply. Staff see every request on a second page. Guests see the answer at once; nobody checks it first.

## Stack
- Plain HTML/CSS/JS frontend, Node backend. No frameworks, no build step.
- Model: "claude-sonnet-5-5" through @anthropic-ai/sdk.
- The API key lives in .env: never in the browser, never in git.

## Style
- Look: a small boutique hotel. White background, navy text (#1B2A41), one warm accent (#C8553D) for buttons and links, the system font, generous spacing. Works on a phone (375px wide).
- Page text: warm, plain English; no emoji, no exclamation marks.
- Staff page: functional, a dense table; no decoration.
- Code: small and plain; a beginner should be able to read it.

## Rules
- Plan first. Don't write code until I say "go".
- One change at a time; then list the files you changed and why.
- Keep the app running after every change.
- Ask before installing a package.
- Don't edit the system prompt text, hotel-policies.md or the data files unless I ask.
- If you send test messages, use the name TEST, and afterwards remove those rows from data/requests.json.
- Don't read .env; never put a key anywhere else.
- Don't commit or push until I say so.
- After two failed fixes, stop and tell me what you tried.
