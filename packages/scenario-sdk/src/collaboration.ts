import { runUniversalAgentLoop } from "@zygos/agent-kernel";
import type { HostPorts } from "@zygos/domain-contract";
import type { CollaborationTask, CollaborationResult } from "./types.ts";
import type { ScenarioRegistry } from "./scenario-registry.ts";

export class CrossScenarioCoordinator {
  private readonly _registry: ScenarioRegistry;
  private readonly _hostPorts: HostPorts;
  private readonly _maxDepth: number;

  constructor(registry: ScenarioRegistry, hostPorts: HostPorts, maxDepth: number = 1) {
    this._registry = registry;
    this._hostPorts = hostPorts;
    this._maxDepth = maxDepth;
  }

  public async delegate(task: CollaborationTask): Promise<CollaborationResult> {
    if (task.recursionDepth > this._maxDepth) {
      throw new Error(
        `CrossScenarioDelegationRefused: Recursion depth ${task.recursionDepth} exceeds max permitted depth ${this._maxDepth}`
      );
    }
    const startMs = this._hostPorts.clock.nowMonotonicMs();
    const failure = (reason: string): CollaborationResult => ({
      taskId: task.taskId,
      parentRunId: task.parentRunId,
      targetScenarioId: task.targetScenarioId,
      status: "FAILED",
      consumedBudget: {
        modelCalls: 0,
        toolCalls: 0,
        durationMs: this._hostPorts.clock.nowMonotonicMs() - startMs,
      },
      returnedArtifacts: [{ error: reason }],
      candidateVerified: false,
    });
    if (task.initiatingScenarioId === task.targetScenarioId) {
      return failure("Self-delegation is not allowed");
    }
    const targetPlugin = this._registry.get(task.targetScenarioId);
    if (!targetPlugin) {
      return failure(`Target scenario '${task.targetScenarioId}' not registered in registry`);
    }
    if (
      task.inheritedBudget.maxModelCalls < 0
      || task.inheritedBudget.maxToolCalls < 0
      || task.inheritedBudget.remainingDeadlineMs <= 0
    ) {
      return failure("Inherited budget exhausted before dispatch");
    }

    try {
      const result = await runUniversalAgentLoop({
        domainAdapter: targetPlugin.domain,
        hostPorts: this._hostPorts,
        runSpec: {
          runId: `run_${task.taskId}`,
          parentRunId: task.parentRunId,
          domainId: targetPlugin.manifest.scenarioId,
          domainVersion: targetPlugin.manifest.version,
          inputRefs: task.inputArtifacts.map((_, index) => `artifact_${task.taskId}_${index}`),
          profileId: "cross_scenario_delegation",
          createdAt: new Date().toISOString(),
        },
        budget: {
          maxModelCalls: task.inheritedBudget.maxModelCalls,
          maxToolCalls: task.inheritedBudget.maxToolCalls,
          deadlineMonotonicMs: startMs + task.inheritedBudget.remainingDeadlineMs,
        },
        rawInput: {
          rawText: task.taskKind,
          metadata: {
            initiatingScenarioId: task.initiatingScenarioId,
            targetScenarioId: task.targetScenarioId,
            inputArtifacts: task.inputArtifacts,
          },
        },
      });
      const status = result.status === "COMPLETED"
        ? "COMPLETED"
        : result.status === "CANCELLED"
          ? "CANCELLED"
          : result.status === "RECOVERY_REQUIRED"
            ? "OUTCOME_UNKNOWN"
            : "FAILED";
      return {
        taskId: task.taskId,
        parentRunId: task.parentRunId,
        targetScenarioId: task.targetScenarioId,
        status,
        consumedBudget: {
          modelCalls: result.metrics.modelCalls,
          toolCalls: result.metrics.toolCalls,
          durationMs: result.metrics.totalDurationMs,
        },
        returnedArtifacts: [{
          artifactKind: "SCENARIO_RUN_RESULT",
          sourceScenarioId: task.initiatingScenarioId,
          targetScenarioId: task.targetScenarioId,
          runId: result.runId,
          status: result.status,
          delivery: result.delivery,
          deliverySummary: result.deliverySummary,
          unresolvedObligations: result.unresolvedObligations,
          obligationStates: result.obligationStates,
          candidateVerified: false,
        }],
        candidateVerified: false,
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}
