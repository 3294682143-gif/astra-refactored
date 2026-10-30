/**
 * @zygos/agent-kernel — Contract Ledger & Unified Budget Accounting.
 *
 * Implements K05 and enforces Invariants I01, I02, I05, I06.
 */

import type { GoalContract, Obligation, ObligationState } from "@zygos/domain-contract";

export interface RootBudget {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly deadlineMonotonicMs: number;
}

export interface BudgetConsumption {
  modelCalls: number;
  toolCalls: number;
  rejectedCalls: number;
  unknownOutcomeCalls: number;
}

/** Current kernel release stamp recorded on every ledger (T38). */
export const KERNEL_VERSION = "1.0.0";

export class ContractLedger {
  private _contract: GoalContract;
  private readonly _budget: RootBudget;
  private readonly _consumption: BudgetConsumption;
  private readonly _kernelVersion: string;

  constructor(initialContract: GoalContract, budget: RootBudget, kernelVersion: string = KERNEL_VERSION) {
    this._contract = initialContract;
    this._budget = budget;
    this._kernelVersion = kernelVersion;
    this._consumption = {
      modelCalls: 0,
      toolCalls: 0,
      rejectedCalls: 0,
      unknownOutcomeCalls: 0,
    };
  }

  /**
   * T38: the kernel release this ledger was created with. In-flight runs keep
   * their original version even after the kernel package is upgraded; only new
   * runs adopt the new version.
   */
  get kernelVersion(): string {
    return this._kernelVersion;
  }

  get contract(): GoalContract {
    return this._contract;
  }

  get consumption(): Readonly<BudgetConsumption> {
    return this._consumption;
  }

  /**
   * I01: Mutate goal contract. Must preserve original input ref and increment version.
   * Silent changes to goals/assumptions without version bump are rejected.
   */
  updateContract(mutator: (current: GoalContract) => { goals: string[]; scope: Record<string, unknown> }): void {
    const updated = mutator(this._contract);
    this._contract = {
      originalInputRef: this._contract.originalInputRef, // Invariant I01: immutable original ref
      goals: updated.goals,
      scope: updated.scope,
      obligations: this._contract.obligations,
      version: this._contract.version + 1, // Invariant I01: must bump version
    };
  }

  /**
   * I02: Update obligation state based on an explicit validator receipt.
   * Completing a task does NOT automatically satisfy obligations.
   */
  recordObligationAssessment(obligationId: string, newState: ObligationState, reason?: string): void {
    const target = this._contract.obligations.find((o: Obligation) => o.id === obligationId);
    if (!target) {
      throw new Error(`Obligation not found: ${obligationId}`);
    }

    const updatedObligations = this._contract.obligations.map((o: Obligation): Obligation => {
      if (o.id === obligationId) {
        const updated: Obligation = {
          ...o,
          state: newState,
          ...(reason !== undefined ? { failureReason: reason } : {}),
        };
        return updated;
      }
      return o;
    });

    this._contract = {
      ...this._contract,
      obligations: updatedObligations,
    };
  }

  /**
   * I05 & I06: Unified root budget gate.
   * Subtasks, repairs, and retries all consume from this single budget.
   */
  canDispatchModelCall(nowMs: number): boolean {
    if (nowMs >= this._budget.deadlineMonotonicMs) {
      this._consumption.rejectedCalls += 1; // Invariant I06: locally rejected (NOT_DISPATCHED)
      return false;
    }
    if (this._consumption.modelCalls >= this._budget.maxModelCalls) {
      this._consumption.rejectedCalls += 1;
      return false;
    }
    return true;
  }

  recordDispatchedModelCall(success: boolean, timedOutWithoutEvidence: boolean = false): void {
    this._consumption.modelCalls += 1;
    if (timedOutWithoutEvidence) {
      this._consumption.unknownOutcomeCalls += 1; // Invariant I06: OUTCOME_UNKNOWN
    }
  }

  canDispatchToolCall(nowMs: number): boolean {
    if (nowMs >= this._budget.deadlineMonotonicMs) {
      this._consumption.rejectedCalls += 1;
      return false;
    }
    if (this._consumption.toolCalls >= this._budget.maxToolCalls) {
      this._consumption.rejectedCalls += 1;
      return false;
    }
    return true;
  }

  recordDispatchedToolCall(): void {
    this._consumption.toolCalls += 1;
  }

  allObligationsAccepted(): boolean {
    return (
      this._contract.obligations.length > 0 &&
      this._contract.obligations.every((o: Obligation) => o.state === "ACCEPTED_WITHIN_SCOPE")
    );
  }
}
