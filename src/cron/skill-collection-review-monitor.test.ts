import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "./skill-collection-review-monitor.js";

describe("resolveSkillCollectionReviewMonitorSpecs", () => {
  it("creates one stable seven-day job for every agent", () => {
    const cfg = {
      agents: {
        entries: {
          main: { workspace: "/tmp/openclaw-shared" },
          ops: { workspace: "/tmp/openclaw-shared" },
          solo: { workspace: "/tmp/openclaw-solo" },
        },
        defaults: { model: "anthropic/claude-sonnet-4-6" },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const specs = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
    );

    expect(specs.map(({ agentId }) => agentId)).toEqual(["main", "ops", "solo"]);
    expect(specs.map(({ input }) => input.declarationKey)).toEqual([
      "skill-collection-review:main",
      "skill-collection-review:ops",
      "skill-collection-review:solo",
    ]);
    expect(specs[0]?.input).toMatchObject({
      name: "skill-collection-review-main",
      displayName: "Skill collection review (main)",
      enabled: true,
      payload: {
        kind: "agentTurn",
        message: expect.any(String),
        toolsAllow: ["ls", "read", "write", "edit", "apply_patch", "exec", "process"],
      },
      schedule: {
        kind: "every",
        everyMs: 7 * 24 * 60 * 60_000,
        anchorMs: expect.any(Number),
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      wakeMode: "next-heartbeat",
    });
    expect(specs[0]?.input.payload).not.toHaveProperty("toolsAllowIsDefault");
    const repeated = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
    );
    expect(repeated.map(({ input }) => input.schedule)).toEqual(
      specs.map(({ input }) => input.schedule),
    );
  });

  it("routes one owner's audit without changing its identity, cadence, or operational policy", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        entries: {
          ops: { tools: { allow: ["read", "write", "edit"], exec: { mode: "deny" } } },
          maintenance: { tools: { profile: "coding", exec: { mode: "auto" } } },
        },
      },
    } satisfies OpenClawConfig;
    const before = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "stable" }),
    );
    const routed = { ...cfg, skills: { workshop: { reviewRunners: { ops: "maintenance" } } } };
    const after = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(routed, [], { schedulerSeed: "stable" }),
    );
    expect(after[0]?.input).toEqual({ ...before[0]?.input, agentId: "maintenance" });
    expect(after[1]).toEqual(before[1]);
    expect(routed.agents.entries.ops.tools).toEqual(cfg.agents.entries.ops.tools);
  });

  it.each([
    "missing",
    "read-denied",
    "exec-denied",
    "write-denied",
    "sandbox-denied",
    "provider-denied",
  ])("disables an explicit route with unmet prerequisites: %s", (failure) => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        entries: {
          ops: {},
          maintenance: {
            sandbox: { mode: failure === "sandbox-denied" ? "non-main" : "off" },
            tools: {
              sandbox: { tools: { deny: failure === "sandbox-denied" ? ["exec"] : [] } },
              byProvider: { anthropic: { deny: failure === "provider-denied" ? ["read"] : [] } },
              profile: "coding",
              deny:
                failure === "read-denied"
                  ? ["read"]
                  : failure === "write-denied"
                    ? ["write", "apply_patch"]
                    : [],
              exec: { mode: failure === "exec-denied" ? "deny" : "auto" },
            },
          },
        },
      },
      skills: {
        workshop: { reviewRunners: { ops: failure === "missing" ? "absent" : "maintenance" } },
      },
    } satisfies OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(false);
    expect(spec?.input.displayName).toContain("runner-prerequisite");
  });

  it("creates jobs for every agent in an explicit fleet", () => {
    const explicitFleet = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as unknown as OpenClawConfig;
    expect(
      Array.from(
        resolveSkillCollectionReviewMonitorSpecs(explicitFleet, []),
        ({ agentId }) => agentId,
      ),
    ).toEqual(["ops", "research"]);

    const systemAgentFleet = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { systemAgent: { agentId: "research" } },
      },
    } as unknown as OpenClawConfig;
    expect(
      Array.from(
        resolveSkillCollectionReviewMonitorSpecs(systemAgentFleet, []),
        ({ agentId }) => agentId,
      ),
    ).toEqual(["ops", "research"]);
  });

  it("retains monitor rows while autonomous review is disabled", () => {
    const cfg = {
      agents: { entries: { main: { workspace: "/tmp/openclaw-disabled" } } },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });
    expect(spec?.input.enabled).toBe(false);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("disables only agents whose complete configured chain cannot enforce the review root", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        entries: {
          blocked: {
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["openai/gpt-still-blocked"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "unsupported" } },
              "openai/gpt-still-blocked": { agentRuntime: { id: "unsupported" } },
            },
          },
          fallback: {
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "unsupported" } },
            },
          },
          codex: {
            model: "openai/gpt-codex",
            models: { "openai/gpt-codex": { agentRuntime: { id: "codex" } } },
          },
          embedded: { model: "anthropic/claude-sonnet-4-6" },
          implicit: { model: "openai/gpt-5.2" },
          cli: { model: "claude-cli/claude-opus-4-6" },
        },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const byAgent = new Map(
      Array.from(resolveSkillCollectionReviewMonitorSpecs(cfg, []), (spec) => [
        spec.agentId,
        spec.input,
      ]),
    );

    expect(byAgent.get("blocked")).toMatchObject({
      enabled: false,
      displayName: expect.stringContaining("no-rooted-runtime"),
    });
    for (const agentId of ["fallback", "embedded", "implicit", "cli", "codex"]) {
      expect(byAgent.get(agentId)?.enabled).toBe(true);
      expect(byAgent.get(agentId)?.displayName).not.toContain("no-rooted-runtime");
    }
  });

  it("does not create session storage while projecting an existing monitor", async () => {
    const testState = await createOpenClawTestState({ label: "skill-review-projection" });
    try {
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: {
              model: "openai/gpt-blocked",
              models: { "openai/gpt-blocked": { agentRuntime: { id: "unsupported" } } },
            },
          },
        },
        skills: { workshop: { autonomous: { mode: "auto" } } },
      };
      const options = { schedulerSeed: "test-seed" };
      const [initial] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], options);
      const [projected] = resolveSkillCollectionReviewMonitorSpecs(
        cfg,
        [
          {
            ...initial!.input,
            id: "existing-review",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            state: {},
          },
        ],
        options,
      );
      expect(projected?.input.enabled).toBe(false);
      expect(await fs.readdir(testState.stateDir)).toEqual([]);
    } finally {
      await testState.cleanup();
    }
  });

  it("keeps an executable agent-scoped review alias enabled", () => {
    const cfg = {
      agents: {
        defaults: { model: "openai/gpt-blocked" },
        entries: {
          reviewer: {
            subagents: { model: "review" },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
              "openai/review": { agentRuntime: { id: "codex" } },
              "anthropic/claude-sonnet-4-6": { alias: "review" },
            },
          },
        },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("does not disable a runnable default when an advisory subagent model can be rejected", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        entries: {
          reviewer: {
            subagents: { model: "openai/gpt-blocked" },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
            models: { "openai/gpt-blocked": { agentRuntime: { id: "codex" } } },
          },
        },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });
});
