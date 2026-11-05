/** Public API of the self-healing engine (design §1): the state machine, its service and the modules the UI, CLI and loop use. */

export * from './types';
export {
  HealingEngine, HealingService,
  type CompleteInput, type EscalateExtra, type FixerTask, type GateDecision, type HealingDelegate, type HealingEngineConfig, type HealingExec, type HealingExecFlags,
  type HealingLog, type HealingRunContext, type HealingServiceOptions, type ModelFailureContext, type ModelFailureResult, type RepoGraphView,
  type ResumeDecision, type WorkerVerdict,
} from './engine';
export { classify, groupFailures, OVERLOAD, parseOutput, type ClassifyInput, type FailureGroup } from './classifier';
export {
  CHECKS_FILE, CHECKS_TEMPLATE, checkDefiningFiles, clearChecksCache, definitionBodies, discoverChecks, fastSpecs, isInCheckScope, loadChecksFile,
  SECURITY_CHECK, type DiscoveredChecks, type DiscoverOptions,
} from './checks';
export { CheckRunner, skipReasonOf, STAGE_ORDER, stageOf, treeFingerprint, type CheckExec, type CheckStage, type SecurityScan, type StagesResult } from './checkRunner';
export { checkDefiningEdit } from './checkDefining';
export { RecoveryStore, LOCK_REFRESH_MS, LOCK_STALE_MS, type AcquireResult, type RecoveryStoreOptions, type UnfinishedSummary } from './recoveryStore';
export { FailureMemory, isMemoryPath, memoryPath, PROJECT_MEMORY_FILE, type MemoryScope, type MemorySuggestion } from './failureMemory';
export { attemptCap, DEFAULT_POLICIES, effectivePolicies, LEGACY_POLICIES } from './policy';
export { backoffMs, decide, type AdjustmentPlan, type RerouteRequirement, type RetryDecision } from './retryController';
export { CheckSemaphore, checkSemaphore, RecoveryBus, recoveryBus, rootSessionId, semaphoreKey, type RecoveryBusMessage } from './scheduler';
export { failureScore, PatchManager, type RollbackResult } from './patchManager';
export { attribute, compare, isWorse } from './regression';
export { buildContract, detectChecksModified, evaluate, formatReport, type GateContract } from './qualityGate';
export { buildIntervention, cliNextCommands, nextActionsFor, outcomeFor, report as escalationReport } from './escalation';
export { recoveryDashboard, type RecoveryDashboard } from './dashboardData';
export { isMutatingToolName, repairJson, repairToolCallText, type RepairedToolCall } from './jsonRepair';
export { diff as treeDiff, snapshot as treeSnapshot, wholeTreeKey, type TreeSnapshot } from './treeSnapshot';
export { exactSignature, genericSignature, humanKey } from './signature';
export { buildEvidence, fixBrief, fixPrompt, parseReply, resolverCommands, type FixPromptMessage } from './rca';
