import { describe, expect, it } from "vitest";
import { buildBriefing, type ConcurrentNote } from "../../src/compile/briefing.js";
import { estimateTokens } from "../../src/compile/budget.js";
import type { LoadedRecord } from "../../src/core/store.js";
import { readBlobs } from "../../src/git/sources.js";
import { createRepo } from "../helpers/fixture-repo.js";

describe("readBlobs", () => {
  it("reads many blobs from one process, by byte length, skipping missing objects", async () => {
    const repo = await createRepo();
    const texts = ["plain\n", "Zürich — café ☕\nsecond line\n", "", "no trailing newline"];
    const ids: string[] = [];
    for (const [n, text] of texts.entries()) {
      repo.write(`f${n}.txt`, text);
      ids.push((await repo.run(["hash-object", "-w", `f${n}.txt`])).trim());
    }
    const missing = "0".repeat(40);
    const blobs = await readBlobs(repo.root, [ids[1] ?? "", missing, ...ids]);
    expect([...blobs.keys()].sort()).toEqual([...new Set(ids)].sort());
    texts.forEach((text, n) => {
      expect(blobs.get(ids[n] ?? "")).toBe(text);
    });
    expect(blobs.has(missing)).toBe(false);
    expect((await readBlobs(repo.root, [])).size).toBe(0);
  });
});

function record(kind: LoadedRecord["kind"], data: Record<string, unknown>): LoadedRecord {
  return { file: `.alethic/x/${String(data.id)}.yaml`, kind, data: { kind, ...data }, text: "" };
}

const TASK = record("task", {
  id: "task-x",
  intent: "Do the thing",
  status: "active",
  confidence: "agent-reported",
  scope: { paths: ["src/**"] },
});

function briefingWith(concurrent: ConcurrentNote[], budget = 2500) {
  return buildBriefing({
    target: "generic",
    budget,
    now: new Date("2026-09-29T10:00:00Z"),
    task: TASK,
    checkpoints: [],
    git: {
      head: "a".repeat(40),
      headShort: "aaaaaaa",
      branch: "main",
      dirty: false,
      changedPaths: [],
    },
    scopePaths: ["src/**"],
    records: [],
    concurrent,
  });
}

describe("concurrent-work section", () => {
  it("is absent when there is no concurrent work", () => {
    expect(briefingWith([]).text).not.toContain("Concurrent work");
  });

  it("stays bounded in the worst case: long names, many files and records, many sources", () => {
    const long = (prefix: string, n: number) => `${prefix}${"x".repeat(n)}`;
    const note = (n: number): ConcurrentNote => ({
      source: long(`feat/very-long-branch-name-${n}-`, 40),
      worktree: long("../worktrees/", 50),
      base: "b".repeat(40),
      uncommitted: true,
      committedAt: "2026-09-28T12:00:00+05:30",
      paths: Array.from({ length: 40 }, (_, i) => long(`src/deeply/nested/module-${i}/`, 80)),
      records: Array.from({ length: 10 }, (_, i) => ({
        uncommitted: true,
        record: record("decision", {
          id: long(`dec-a-very-long-decision-id-${i}-`, 30),
          status: "accepted",
          topic: long("area.topic-", 30),
          chosen: long("A very long choice ", 500),
          confidence: "agent-reported",
        }),
      })),
      withheld: 3,
    });
    const briefing = briefingWith(Array.from({ length: 12 }, (_, n) => note(n)));
    const section = briefing.sections.find((s) => s.key === "concurrent");
    const text = section?.items.map((item) => item.text).join("\n") ?? "";
    // 3 sources, 2 record lines, the overflow line, and the closing line.
    expect(section?.items).toHaveLength(7);
    expect(text).toContain("9 more branches or worktrees have work in your scope.");
    expect(estimateTokens(text)).toBeLessThan(450);
    // Citations and trust markers are never cut.
    const recordLines = section?.items.filter((item) => item.record) ?? [];
    expect(recordLines).toHaveLength(2);
    for (const line of recordLines) {
      expect(line.text).toMatch(/^\[dec-a-very-long-decision-id-\d-x+ on feat\/[^\]]+\] /);
      expect(line.text).toMatch(/⚠ unverified$/);
    }
  });

  it("keeps the section even when the budget is too small for it", () => {
    const briefing = briefingWith(
      [
        {
          source: "feat/other",
          base: "c".repeat(40),
          uncommitted: false,
          paths: ["src/a.ts"],
          records: [],
          withheld: 0,
        },
      ],
      200,
    );
    expect(briefing.text).toContain(
      "- feat/other changed 1 file in your scope (src/a.ts) since it split from this branch at ccccccc.",
    );
  });
});
