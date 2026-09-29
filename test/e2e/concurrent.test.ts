import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/git.js";
import type { FixtureRepo } from "../helpers/fixture-repo.js";
import { connectMcp, textOf } from "../helpers/mcp-client.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo } from "../helpers/workspace.js";

const OUR_TASK = "task-invalidate-sessions-after-password-reset";
const AT = "2026-09-13T18:00:00Z";

/** A repository on `main` with our task started and committed. */
async function withOurTask(...paths: string[]): Promise<FixtureRepo> {
  const repo = await initializedRepo();
  expectOk(
    await cli(
      [
        "task",
        "start",
        "Invalidate sessions after password reset",
        "--paths",
        ...(paths.length > 0 ? paths : ["apps/api/auth/**"]),
      ],
      as(repo, "codex", AT),
    ),
  );
  await repo.commitAll("Start task");
  return repo;
}

/** Runs `work` on a new branch from main, commits it, and returns to main. */
async function onBranch(
  repo: FixtureRepo,
  branch: string,
  work: () => Promise<void> | void,
): Promise<void> {
  await repo.run(["checkout", "-q", "-b", branch, "main"]);
  await work();
  await repo.commitAll(`Work on ${branch}`);
  await repo.run(["checkout", "-q", "main"]);
}

/** A worktree next to the repository, on a new branch from main. */
async function addWorktree(repo: FixtureRepo, branch: string): Promise<string> {
  const dir = `${repo.root}-${branch.replace(/\//g, "-")}`;
  await repo.run(["worktree", "add", "-q", "-b", branch, dir, "main"]);
  return dir;
}

function section(briefing: string): string {
  const start = briefing.indexOf("## Concurrent work on other branches");
  if (start === -1) return "";
  const end = briefing.indexOf("\n## ", start + 1);
  return briefing.slice(start, end === -1 ? undefined : end);
}

async function resume(repo: FixtureRepo, ...args: string[]): Promise<string> {
  return expectOk(await cli(["resume", "--budget", "2500", ...args], as(repo, "codex", AT))).stdout;
}

async function statusJson(repo: FixtureRepo) {
  return JSON.parse(
    expectOk(await cli(["status", "--all-branches", "--json"], as(repo, "codex", AT))).stdout,
  );
}

describe("concurrent work on other branches", () => {
  it("names changed files and records in the task's scope, and nothing else", async () => {
    const repo = await withOurTask();
    await repo.run(["branch", "already-merged"]);
    await onBranch(repo, "feat/token-refresh", async () => {
      repo.write(
        "apps/api/auth/refresh.ts",
        "export function refresh() { return { access: 'a', refresh: 'r' }; }\n",
      );
      expectOk(
        await cli(
          [
            "decision",
            "add",
            "--topic",
            "auth.refresh-return-shape",
            "--chosen",
            "refresh() returns {access, refresh} instead of a string",
            "--rationale",
            "Rotation needs both tokens",
            "--paths",
            "apps/api/auth/refresh.ts",
          ],
          as(repo, "claude-code", AT),
        ),
      );
    });
    await onBranch(repo, "feat/docs", () => {
      repo.write("README.md", "# workspace\n\nMore docs.\n");
    });

    const briefing = await resume(repo);
    const notes = section(briefing);
    expect(notes).toContain(
      "feat/token-refresh (last commit 20", // the date is Git state, not pinned in tests
    );
    expect(notes).toContain("changed 1 file in your scope (apps/api/auth/refresh.ts)");
    expect(notes).toContain("recorded 1 item about it");
    expect(notes).toContain(
      "[dec-auth-refresh-return-shape on feat/token-refresh] Decided on auth.refresh-return-shape: refresh() returns {access, refresh} instead of a string. ⚠ unverified",
    );
    expect(notes).not.toContain("feat/docs");
    expect(notes).not.toContain("already-merged");
    // The section sits between the integrity warnings and the decisions.
    expect(briefing.indexOf("## Concurrent work")).toBeGreaterThan(
      briefing.indexOf("## Current repository state"),
    );
    expect(briefing.indexOf("## Concurrent work")).toBeLessThan(
      briefing.indexOf("## Relevant architecture and decisions"),
    );

    // Same Git state, byte-identical briefing (spec §14).
    expect(await resume(repo)).toBe(briefing);
    expect(section(await resume(repo, "--no-concurrent"))).toBe("");

    const json = JSON.parse(await resume(repo, "--format", "json"));
    expect(json.concurrent).toHaveLength(1);
    expect(json.concurrent[0]).toMatchObject({
      source: "feat/token-refresh",
      branch: "feat/token-refresh",
      uncommitted: false,
      paths: ["apps/api/auth/refresh.ts"],
      records: [{ id: "dec-auth-refresh-return-shape", kind: "decision", uncommitted: false }],
      withheld: 0,
    });

    // Status lists every source, in scope or not; the merged branch is never a source.
    const status = await statusJson(repo);
    expect(status.concurrent.sources.map((s: { source: string }) => s.source)).toEqual([
      "feat/docs",
      "feat/token-refresh",
    ]);
    expect(status.concurrent.sources[0].changedPaths).toEqual(["README.md"]);

    const shown = expectOk(
      await cli(
        ["show", "dec-auth-refresh-return-shape", "--ref", "feat/token-refresh"],
        as(repo, "codex", AT),
      ),
    ).stdout;
    expect(shown).toContain("# dec-auth-refresh-return-shape (decision) on feat/token-refresh");
    expect(shown).toContain("Freshness: not judged");
    const missing = await cli(["show", "dec-auth-refresh-return-shape"], as(repo, "codex", AT));
    expect(missing.code).toBe(2);
  });

  it("reads uncommitted records from other worktrees and labels them", async () => {
    const repo = await withOurTask();
    const dir = await addWorktree(repo, "feat/rotate");
    const worktree = { cwd: dir, env: { ALETHIC_AGENT: "claude-code", ALETHIC_NOW: AT } };
    expectOk(
      await cli(
        [
          "task",
          "start",
          "Rotate refresh tokens on every use",
          "--paths",
          "apps/api/auth/refresh.ts",
        ],
        worktree,
      ),
    );

    const notes = section(await resume(repo));
    const display = `../${path.basename(dir)}`;
    expect(notes).toContain(`feat/rotate (worktree ${display}; uncommitted changes; last commit`);
    expect(notes).toContain("recorded 1 item about your scope or task");
    expect(notes).toContain(
      "[task-rotate-refresh-tokens-on-every-use on feat/rotate] active task by claude-code: Rotate refresh tokens on every use. (uncommitted) ⚠ unverified",
    );

    const status = await statusJson(repo);
    expect(status.concurrent.sources[0]).toMatchObject({
      source: "feat/rotate",
      worktree: display,
      uncommitted: true,
      tasks: [{ id: "task-rotate-refresh-tokens-on-every-use", uncommitted: true }],
    });

    for (const ref of ["feat/rotate", display, `worktree ${display}`, dir]) {
      const shown = await cli(
        ["show", "task-rotate-refresh-tokens-on-every-use", "--ref", ref],
        as(repo, "codex", AT),
      );
      expect(shown.stdout, ref).toContain(`From:      feat/rotate (worktree ${display})`);
    }
  });

  it("keeps reading a branch after its worktree directory is deleted", async () => {
    const repo = await withOurTask();
    const dir = await addWorktree(repo, "feat/gone");
    expectOk(
      await cli(
        [
          "knowledge",
          "add",
          "--category",
          "gotcha",
          "--body",
          "Refresh tokens live in Redis for 15 minutes",
          "--paths",
          "apps/api/auth/refresh.ts",
        ],
        { cwd: dir, env: { ALETHIC_AGENT: "gemini", ALETHIC_NOW: AT } },
      ),
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "knowledge"]);
    rmSync(dir, { recursive: true, force: true });

    const notes = section(await resume(repo));
    expect(notes).toContain("feat/gone (last commit");
    expect(notes).not.toContain("(worktree");
    expect(notes).toContain("Refresh tokens live in Redis for 15 minutes.");
  });

  it("applies this checkout's privacy settings to other branches", async () => {
    const repo = await withOurTask("apps/api/auth/**", "customers/**");
    const manifest = path.join(repo.root, ".alethic", "manifest.yaml");
    const strict = readFileSync(manifest, "utf8")
      .replace("extra_secret_patterns: []", 'extra_secret_patterns:\n    - "ACME-[0-9]{6}"')
      .replace("forbidden_globs:\n", 'forbidden_globs:\n    - "customers/**"\n');
    writeFileSync(manifest, strict);
    await repo.commitAll("Tighten privacy");

    await onBranch(repo, "feat/leaky", async () => {
      // The branch weakens its own manifest, then records what this checkout forbids.
      writeFileSync(
        manifest,
        strict
          .replace('extra_secret_patterns:\n    - "ACME-[0-9]{6}"', "extra_secret_patterns: []")
          .replace('    - "customers/**"\n', ""),
      );
      repo.write("customers/acme.csv", "id,name\n1,Acme\n");
      repo.write("apps/api/auth/session.ts", "export function createSession() { return 1; }\n");
      expectOk(
        await cli(
          [
            "decision",
            "add",
            "--topic",
            "auth.customer-keys",
            "--chosen",
            "Use key ACME-123456 for the Acme tenant",
            "--rationale",
            "It works",
            "--paths",
            "apps/api/auth/session.ts",
          ],
          as(repo, "claude-code", AT),
        ),
      );
    });

    const briefing = await resume(repo);
    const status = expectOk(
      await cli(["status", "--all-branches", "--json"], as(repo, "codex", AT)),
    ).stdout;
    for (const output of [briefing, status]) {
      expect(output).not.toContain("customers/acme.csv");
      expect(output).not.toContain("ACME-123456");
    }
    expect(section(briefing)).toContain("feat/leaky (last commit");
    expect(section(briefing)).toContain("1 record there failed validation and is not shown.");
    expect(JSON.parse(status).concurrent.sources[0].withheld).toBe(1);
  });

  it("judges odd entries on a branch by the same rules as this checkout", async () => {
    const repo = await withOurTask();
    await onBranch(repo, "feat/odd", async () => {
      expectOk(
        await cli(
          [
            "knowledge",
            "add",
            "--category",
            "gotcha",
            "--body",
            "Zürich sessions expire in 15 minutes — see café notes",
            "--paths",
            "apps/api/auth/session.ts",
          ],
          as(repo, "claude-code", AT),
        ),
      );
      repo.write(".alethic/knowledge/kn-old-style.yml", "id: kn-old-style\n");
      repo.write(".alethic/knowledge/kn-list.yaml", "- not\n- a mapping\n");
      symlinkSync("kn-list.yaml", path.join(repo.root, ".alethic/knowledge/kn-link.yaml"));
    });

    const notes = section(await resume(repo));
    expect(notes).toContain("Zürich sessions expire in 15 minutes — see café notes.");
    const status = await statusJson(repo);
    // The .yml file and the non-mapping file are errors (withheld); the symlink is a warning.
    expect(status.concurrent.sources[0].withheld).toBe(2);
    expect(status.concurrent.sources[0].knowledge).toHaveLength(1);
  });

  it("says when another branch updated this task", async () => {
    const repo = await withOurTask();
    await onBranch(repo, "feat/parallel-claim", async () => {
      expectOk(
        await cli(
          ["checkpoint", "create", "--task", OUR_TASK, "--next", "Bump token_version in reset()"],
          as(repo, "gemini", "2026-09-13T18:30:00Z"),
        ),
      );
    });
    const notes = section(await resume(repo));
    expect(notes).toContain("recorded 1 item about your scope or task");
    expect(notes).toMatch(
      /\[cp-[^\]]+ on feat\/parallel-claim\] A checkpoint for your task by gemini, next: Bump token_version in reset\(\)\./,
    );
  });

  it("caps the section and points to status for the rest", async () => {
    const repo = await withOurTask();
    for (const n of [1, 2, 3, 4, 5]) {
      await onBranch(repo, `feat/area-${n}`, () => {
        repo.write(`apps/api/auth/file-${n}.ts`, `export const n = ${n};\n`);
      });
    }
    const notes = section(await resume(repo));
    expect(notes.match(/^- feat\/area-\d/gm)).toHaveLength(3);
    expect(notes).toContain(
      "2 more branches or worktrees have work in your scope. (see `alethic status --all-branches`)",
    );
    expect((await statusJson(repo)).concurrent.sources).toHaveLength(5);
  });

  it("skips branches that share no history with this one", async () => {
    const repo = await withOurTask();
    await repo.run(["checkout", "-q", "--orphan", "gh-pages"]);
    await repo.run(["rm", "-rq", "--cached", "."]);
    repo.write("index.html", "<p>site</p>\n");
    await repo.run(["add", "index.html"]);
    await repo.run(["commit", "-q", "-m", "site"]);
    await repo.run(["checkout", "-q", "-f", "main"]);

    const status = await statusJson(repo);
    expect(status.concurrent.unrelated).toEqual(["gh-pages"]);
    expect(section(await resume(repo))).toBe("");
  });

  it("is available through the MCP status tool", async () => {
    const repo = await withOurTask();
    await onBranch(repo, "feat/mcp", () => {
      repo.write("apps/api/auth/refresh.ts", "export function refresh() { return 2; }\n");
    });
    const session = await connectMcp(repo.root, "claude-code");
    try {
      const plain = JSON.parse(textOf(await session.call("status")));
      expect(plain.concurrent).toBeUndefined();
      const all = JSON.parse(textOf(await session.call("status", { all_branches: true })));
      expect(all.concurrent.sources.map((s: { source: string }) => s.source)).toEqual(["feat/mcp"]);
      const briefing = textOf(await session.call("resume", { target: "claude-code" }));
      expect(section(briefing)).toContain("feat/mcp");
    } finally {
      await session.close();
    }
  });
});
