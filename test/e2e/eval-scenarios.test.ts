import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "examples/eval/build-scenario.sh");
/** Well after every scenario's timestamps, so leases have expired as they would in a real trial. */
const LATER = "2026-09-15T09:00:00Z";
const BUDGET = 600;

let bin: string;

beforeAll(async () => {
  // Build this checkout, as the demo test does, so scenarios never use a stale dist/.
  const cache = path.join(ROOT, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(path.join(cache, "alethic-eval-build-"));
  await run(path.join(ROOT, "node_modules/.bin/tsup"), ["--out-dir", out], { cwd: ROOT });
  bin = path.join(out, "cli.js");
  return () => rmSync(out, { recursive: true, force: true });
}, 120_000);

async function build(scenario: string, condition: string): Promise<string> {
  const out = mkdtempSync(path.join(tmpdir(), `alethic-eval-${scenario}-${condition}-`));
  await run("bash", [SCRIPT, scenario, condition, out], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ALETHIC_BIN: `node ${bin}` },
    timeout: 120_000,
  }).catch((error: { stderr?: string; message: string }) => {
    throw new Error(`${error.message}\n${error.stderr ?? ""}`);
  });
  return out;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return (await run("git", args, { cwd, env })).stdout.trim();
}

/** What the next session must learn, and must still see in a small briefing. */
const CRITICAL: Record<string, string[]> = {
  "failed-approach": [
    "Delete session rows on reset",
    "refresh() reads the refresh cache first, so cached sessions keep working",
  ],
  "changed-evidence": ["[dec-auth-session-invalidation] ⚠ may be stale"],
  "conflicting-decisions": [
    "Disputed: accepted decisions [dec-sessions-in-memory] and [dec-sessions-in-redis]",
  ],
  "expired-ownership": [
    "lease expired at 2026-09-14T13:10:00Z",
    "Export lastPasswordReset(userId)",
  ],
  "incomplete-checks": ["`node --test` passed at", "changed since"],
  "concurrent-change": [
    "feat/token-pair (last commit 2026-09-14) changed 1 file in your scope (src/sessions.js)",
    "[dec-auth-sign-in-result on feat/token-pair] Decided on auth.sign-in-result: signIn(userId) returns { access, refresh } instead of a token string",
  ],
};

describe("evaluation scenarios (scripted: what a fresh session is given)", () => {
  for (const [scenario, facts] of Object.entries(CRITICAL)) {
    it(`${scenario}: the critical facts survive a ${BUDGET}-token briefing`, async () => {
      const out = await build(scenario, "alethic");
      const { task } = JSON.parse(readFileSync(path.join(out, "scenario.json"), "utf8"));
      const { stdout } = await run(
        "node",
        [bin, "resume", "--task", task, "--budget", String(BUDGET), "--target", "generic"],
        { cwd: path.join(out, "repo"), env: { ...process.env, ALETHIC_NOW: LATER } },
      );
      for (const fact of facts) expect(stdout, fact).toContain(fact);
      expect(Math.ceil(stdout.length / 4)).toBeLessThanOrEqual(BUDGET);
    }, 180_000);
  }

  it("gives every condition the same code, commits, and prompt", async () => {
    const outs = await Promise.all(
      ["alethic", "handoff-file", "git-only"].map((condition) =>
        build("failed-approach", condition),
      ),
    );
    const [alethic, handoff, gitOnly] = outs as [string, string, string];
    const prompts = outs.map((out) => readFileSync(path.join(out, "PROMPT.md"), "utf8"));
    expect(new Set(prompts).size).toBe(1);

    const trees = await Promise.all(
      outs.map((out) => git(path.join(out, "repo"), ["rev-parse", "HEAD:src"])),
    );
    expect(new Set(trees).size).toBe(1);
    const counts = await Promise.all(
      outs.map((out) => git(path.join(out, "repo"), ["rev-list", "--count", "HEAD"])),
    );
    expect(new Set(counts).size).toBe(1);

    expect(existsSync(path.join(alethic, "repo/.alethic/manifest.yaml"))).toBe(true);
    expect(existsSync(path.join(alethic, "repo/HANDOFF.md"))).toBe(false);
    expect(readFileSync(path.join(handoff, "repo/HANDOFF.md"), "utf8")).toContain(
      "refresh() reads the refresh cache first",
    );
    expect(existsSync(path.join(handoff, "repo/.alethic"))).toBe(false);
    expect(existsSync(path.join(gitOnly, "repo/.alethic"))).toBe(false);
    expect(existsSync(path.join(gitOnly, "repo/HANDOFF.md"))).toBe(false);
    expect(readFileSync(path.join(gitOnly, "SCORING.md"), "utf8")).toContain(
      "# Scoring: failed-approach (git-only)",
    );
  }, 240_000);
});
