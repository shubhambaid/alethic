import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/git.js";
import { cli } from "../helpers/run-cli.js";
import { as, expectOk, initializedRepo } from "../helpers/workspace.js";

const FAKE_EMBEDDER = fileURLToPath(new URL("../fixtures/embedder/concepts.mjs", import.meta.url));

async function seeded() {
  const repo = await initializedRepo();
  const run = async (args: string[]) => expectOk(await cli(args, as(repo, "codex")));
  await run([
    ...["decision", "add", "--topic", "auth.session-store", "--id", "dec-store"],
    ...["--chosen", "Keep sessions in Postgres", "--rationale", "One store, one backup."],
    ...["--alternative", "Redis::another service to operate"],
  ]);
  await run([
    ...["knowledge", "add", "--category", "gotcha", "--id", "kn-cookie"],
    ...["--body", "The browser cookie is cleared when a user signs out of the account."],
    ...["--summary", "Sign out clears the cookie"],
  ]);
  await run([
    ...["knowledge", "add", "--category", "operations", "--id", "kn-release"],
    ...["--body", "Releases ship from main every Tuesday after the rollout check."],
    ...["--summary", "Weekly release train"],
  ]);
  return { repo, run };
}

describe("alethic search", () => {
  it("ranks by keywords with freshness and trust, and needs no model", async () => {
    const { repo } = await seeded();
    const result = expectOk(await cli(["search", "postgres sessions"], { cwd: repo.root }));
    expect(result.stdout).toContain('Search: "postgres sessions" (keywords;');
    const first = result.stdout.split("\n").find((line) => /^1\. /.test(line));
    expect(first).toContain("dec-store (decision, accepted)");
    expect(result.stdout).toContain("agent-reported · freshness: unanchored · matched by keywords");
    expect(result.stdout).not.toContain("kn-release");
  });

  it("filters by kind and limit, and prints JSON", async () => {
    const { repo } = await seeded();
    const json = JSON.parse(
      expectOk(
        await cli(["search", "cookie", "--kind", "knowledge", "--limit", "1", "--json"], {
          cwd: repo.root,
        }),
      ).stdout,
    );
    expect(json).toMatchObject({ mode: "keyword", withheld: 0 });
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ id: "kn-cookie", kind: "knowledge" });
    const bad = await cli(["search", "x", "--kind", "bogus"], { cwd: repo.root });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--kind must be one of");
  });

  it("never searches records that failed validation", async () => {
    const { repo } = await seeded();
    repo.write(
      ".alethic/knowledge/kn-leak.yaml",
      [
        "id: kn-leak",
        "kind: knowledge",
        "schema_version: 1",
        "summary: Admin login",
        "status: active",
        "confidence: agent-reported",
        "category: operations",
        "body: The admin uses password = Hunter2Hunter2!",
        "created_by:",
        "  agent: codex",
        'created_at: "2026-09-13T20:00:00Z"',
        "",
      ].join("\n"),
    );
    const result = expectOk(await cli(["search", "admin password"], { cwd: repo.root }));
    expect(result.stdout).not.toContain("Hunter2");
    expect(result.stdout).not.toContain("kn-leak");
    expect(result.stdout).toContain("1 record failed validation and was not searched");
  });

  it("flags a record whose cited code changed", async () => {
    const { repo, run } = await seeded();
    await run([
      ...["decision", "add", "--topic", "auth.refresh", "--id", "dec-refresh"],
      ...["--chosen", "Rotate refresh tokens", "--rationale", "Limits replay."],
      ...["--evidence-file", "apps/api/auth/refresh.ts"],
    ]);
    await repo.commitAll("record");
    repo.write("apps/api/auth/refresh.ts", "export function refresh() { return 1; }\n");
    const json = JSON.parse(
      expectOk(await cli(["search", "refresh tokens", "--json"], { cwd: repo.root })).stdout,
    );
    expect(json.results[0]).toMatchObject({ id: "dec-refresh", freshness: "needs_reverification" });
  });

  describe("with an embedder", () => {
    const env = { ALETHIC_EMBEDDER_MODULE: FAKE_EMBEDDER };

    it("finds a record that shares no word with the query, and fuses both rankings", async () => {
      const { repo } = await seeded();
      const keywordOnly = JSON.parse(
        expectOk(await cli(["search", "logout", "--json"], { cwd: repo.root })).stdout,
      );
      expect(keywordOnly.results).toEqual([]);

      const result = expectOk(
        await cli(["search", "log out", "--semantic", "--json"], { cwd: repo.root, env }),
      );
      const json = JSON.parse(result.stdout);
      expect(json).toMatchObject({ mode: "hybrid", embedder: "fake:256" });
      const ids = json.results.map((entry: { id: string }) => entry.id);
      expect(ids.slice(0, 2).sort()).toEqual(["dec-store", "kn-cookie"]);
      expect(ids.indexOf("kn-release")).toBeGreaterThan(1);
      expect(json.results[0].matched).toContain("meaning");
      expect(json.results[0].similarity).toBeGreaterThan(0.5);
    });

    it("keeps vectors in the Git directory and re-embeds only what changed", async () => {
      const { repo, run } = await seeded();
      (globalThis as { __alethicEmbedCalls?: number[] }).__alethicEmbedCalls = [];
      const calls = () =>
        (globalThis as { __alethicEmbedCalls?: number[] }).__alethicEmbedCalls ?? [];
      expectOk(await cli(["search", "cookie", "--semantic"], { cwd: repo.root, env }));
      expect(calls()).toEqual([3]);
      expectOk(await cli(["search", "cookie", "--semantic"], { cwd: repo.root, env }));
      expect(calls()).toEqual([3]);

      await run([
        ...["knowledge", "add", "--category", "convention", "--id", "kn-new"],
        ...["--body", "Deploy previews run on every pull request."],
      ]);
      expectOk(await cli(["search", "cookie", "--semantic"], { cwd: repo.root, env }));
      expect(calls()).toEqual([3, 1]);

      const gitDir = (await git(repo.root, ["rev-parse", "--git-common-dir"])).stdout.trim();
      expect(existsSync(path.resolve(repo.root, gitDir, "alethic", "embeddings.json"))).toBe(true);
      expect((await git(repo.root, ["status", "--porcelain"])).stdout).not.toContain("embeddings");
    });

    it("follows the manifest, and --no-semantic turns it off", async () => {
      const { repo } = await seeded();
      const manifest = path.join(repo.root, ".alethic/manifest.yaml");
      const { readFileSync, writeFileSync } = await import("node:fs");
      writeFileSync(manifest, `${readFileSync(manifest, "utf8")}search:\n  semantic: true\n`);
      const on = JSON.parse(
        expectOk(await cli(["search", "log out", "--json"], { cwd: repo.root, env })).stdout,
      );
      expect(on.mode).toBe("hybrid");
      const off = JSON.parse(
        expectOk(
          await cli(["search", "log out", "--no-semantic", "--json"], { cwd: repo.root, env }),
        ).stdout,
      );
      expect(off.mode).toBe("keyword");
    });

    it("fails loudly for --semantic and falls back for the manifest default", async () => {
      const { repo } = await seeded();
      const broken = { ALETHIC_EMBEDDER_MODULE: path.join(repo.root, "missing.mjs") };
      const explicit = await cli(["search", "cookie", "--semantic"], {
        cwd: repo.root,
        env: broken,
      });
      expect(explicit.code).toBe(2);
      expect(explicit.stderr).toContain("Could not load ALETHIC_EMBEDDER_MODULE");

      const manifest = path.join(repo.root, ".alethic/manifest.yaml");
      const { readFileSync, writeFileSync } = await import("node:fs");
      writeFileSync(manifest, `${readFileSync(manifest, "utf8")}search:\n  semantic: true\n`);
      const fallback = expectOk(await cli(["search", "cookie"], { cwd: repo.root, env: broken }));
      expect(fallback.stderr).toContain("searching by keywords only");
      expect(fallback.stdout).toContain("kn-cookie");
    });
  });
});
