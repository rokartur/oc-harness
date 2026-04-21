export {
	discoverExtraContext,
	discoverClaudeRules,
	discoverRootContext,
	type ExtraContext,
	type RootContextOptions,
} from './instructions.js'
export { ContextArtifactCache, buildContextArtifact, type ContextArtifact } from './artifacts.js'
export {
	SessionStateTracker,
	buildCompactionContext,
	formatCompactionAttachments,
	truncateCompactionContext,
	type TaskFocusState,
	type CompactionContext,
} from './compaction.js'
