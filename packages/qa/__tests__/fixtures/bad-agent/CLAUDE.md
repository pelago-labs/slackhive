# Bad Test Agent

A fixture agent seeded with violations for each QA00N check, used in unit tests.

## Step 0 — Detect Trigger

- **Trigger pattern `bad hello`** → run the bad flow.
- This agent references `mcp__undeclared-tool__do-thing` which is NOT declared in mcps.yaml — seeded violation for QA001.

## More

The skill below references another undeclared MCP — seeded violation for QA001.
