import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../../src/mcp/server.js";
import { serveStdio } from "../../src/mcp/stdio.js";
import { runCli } from "../../src/program.js";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { connectMcp, type McpSession, serverIo, textOf } from "../helpers/mcp-client.js";
import { initializedRepo, readRecord } from "../helpers/workspace.js";

const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`.slice(0, 40);

let repo: FixtureRepo;
let session: McpSession;

function files(dir: string): string[] {
  return readdirSync(path.join(repo.root, ".alethic", dir)).filter((f) => f.endsWith(".yaml"));
}

beforeEach(async () => {
  repo = await initializedRepo();
  session = await connectMcp(repo.root, "claude-code");
});

afterEach(async () => {
  await session.close();
});

describe("alethic mcp", () => {
  it("initializes with the official client and lists tools", async () => {
    const { client } = session;
    expect(client.getServerVersion()?.name).toBe("alethic");
    expect(client.getInstructions()).toContain("Call `resume` before non-trivial work");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "resume",
      "status",
      "search",
      "validate",
      "task_start",
      "task_claim",
      "checkpoint_create",
      "receipt_record",
      "decision_add",
      "knowledge_add",
    ]);
    for (const tool of tools) expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("human");
  });

  it("runs a task through the same code paths as the CLI", async () => {
    const { call } = session;
    const started = await call("task_start", {
      intent: "Sessions issued before a password reset stop working.",
      summary: "Invalidate sessions after password reset",
      paths: ["apps/api/auth/**"],
      next: "Add token_version to users.",
    });
    expect(started.isError, textOf(started)).toBe(false);
    const taskId = JSON.parse(textOf(started)).id as string;
    expect(taskId).toBe("task-invalidate-sessions-after-password-reset");

    const receipt = await call("receipt_record", {
      command: "pnpm test auth",
      exit_code: 1,
      output: `FAIL auth.test.ts\nGITHUB_TOKEN=${GITHUB_TOKEN}\nexpected 401, received 200\n`,
    });
    expect(receipt.isError, textOf(receipt)).toBe(false);
    const stored = readRecord(repo, JSON.parse(textOf(receipt)).file as string);
    expect(stored.result).toBe("fail");
    expect(stored.confidence).toBe("agent-reported");
    expect(String(stored.output_tail)).toContain("expected 401, received 200");
    expect(String(stored.output_tail)).not.toContain(GITHUB_TOKEN);

    const decision = await call("decision_add", {
      topic: "auth.session-invalidation",
      chosen: "Store token_version on users",
      rationale: "One write per user revokes every session.",
      alternatives: [{ option: "Delete session rows", rejected_because: "Cache outlives it" }],
      links: [taskId],
    });
    expect(decision.isError, textOf(decision)).toBe(false);

    const checkpoint = await call("checkpoint_create", {
      failed_approaches: [{ approach: "Delete session rows", why_failed: "Redis cache" }],
      open_questions: ["Does mobile retry on 401?"],
      next: "Invalidate the cached refresh entry.",
    });
    expect(checkpoint.isError, textOf(checkpoint)).toBe(false);
    expect(JSON.parse(textOf(checkpoint)).receipts).toHaveLength(1);

    const briefing = textOf(await call("resume", { target: "claude-code", budget: 1500 }));
    expect(briefing).toContain(`# Alethic briefing: ${taskId}`);
    expect(briefing).toContain("Invalidate the cached refresh entry.");
    expect(briefing).toContain("Delete session rows");

    const validation = await call("validate");
    expect(validation.isError).toBe(false);
    expect(JSON.parse(textOf(validation)).findings).toEqual([]);
    const status = JSON.parse(textOf(await call("status")));
    expect(status.activeTasks.map((t: { id: string }) => t.id)).toEqual([taskId]);
  });

  it("returns tool errors for secrets, bad arguments, and held leases without writing", async () => {
    const { call } = session;
    const started = await call("task_start", { intent: "Rotate refresh tokens on every use." });
    const taskId = JSON.parse(textOf(started)).id as string;

    const secret = await call("checkpoint_create", { done: [`Set token ${GITHUB_TOKEN}`] });
    expect(secret.isError).toBe(true);
    expect(textOf(secret)).toContain("done[0] looks like a GitHub token");
    expect(textOf(secret)).not.toContain(GITHUB_TOKEN);
    expect(files("checkpoints")).toEqual([]);

    const missing = await call("task_start", { summary: "no intent" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain(
      "Invalid arguments: arguments must have required property 'intent'",
    );

    const extra = await call("decision_add", {
      topic: "a.b",
      chosen: "x",
      rationale: "y",
      human: "Alice",
    });
    expect(extra.isError).toBe(true);
    expect(textOf(extra)).toContain('unknown property "human"');
    expect(files("decisions")).toEqual([]);

    const separator = await call("checkpoint_create", {
      failed_approaches: [{ approach: "a::b", why_failed: "c" }],
    });
    expect(separator.isError).toBe(true);
    expect(textOf(separator)).toContain('approach must not contain "::"');

    const flagLike = await call("task_start", { intent: "--force", id: "task-flag-like" });
    expect(flagLike.isError, textOf(flagLike)).toBe(false);
    expect(readRecord(repo, ".alethic/tasks/task-flag-like.yaml").intent).toBe("--force");

    const claim = await call("task_claim", { id: taskId, agent: "gemini" });
    expect(claim.isError).toBe(true);
    expect(textOf(claim)).toContain("claude-code");

    await expect(call("no_such_tool")).rejects.toThrow(/Unknown tool/);
  });

  it("serves status and records as resources", async () => {
    const { call, client } = session;
    const started = await call("task_start", { intent: "Rotate refresh tokens on every use." });
    const taskId = JSON.parse(textOf(started)).id as string;

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([
      "alethic://status",
      `alethic://records/${taskId}`,
    ]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0]?.uriTemplate).toBe("alethic://records/{id}");

    const record = await client.readResource({ uri: `alethic://records/${taskId}` });
    const content = record.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe("application/yaml");
    expect(content.text).toContain(`id: ${taskId}`);

    const status = await client.readResource({ uri: "alethic://status" });
    expect(() => JSON.parse((status.contents[0] as { text: string }).text)).not.toThrow();

    await expect(
      client.readResource({ uri: "alethic://records/../../etc/passwd" }),
    ).rejects.toThrow(/Resource not found/);
  });
});

describe("alethic mcp stdio framing", () => {
  it("answers parse errors, ignores notifications, and writes one line per response", async () => {
    const input = new PassThrough();
    let output = "";
    const served = serveStdio(
      createMcpHandler({ io: serverIo(repo.root, "claude-code"), run: runCli }),
      input,
      (text) => {
        output += text;
      },
    );
    input.write("{not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\r\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/unknown" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "1.0", id: 9, method: "ping" })}\n`);
    input.end();
    await served;

    expect(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 7, result: {} },
      { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 9, error: { code: -32600, message: "Invalid Request" } },
    ]);
    expect(existsSync(path.join(repo.root, ".alethic"))).toBe(true);
  });
});
