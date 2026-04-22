export {
	discoverExtraContext,
	discoverClaudeRules,
	discoverRootContext,
	type ExtraContext,
	type RootContextOptions,
} from './instructions.js'
export { ContextArtifactCache, buildContextArtifact, type ContextArtifact } from './artifacts.js'
export {
	CAVEMAN_FILE_MODES,
	compressContextFile,
	compressFileContent,
	validateCompressedContent,
	type CavemanFileMode,
	type CompressFileResult,
	type CompressionValidationResult,
} from './compress-file.js'
export {
	SessionStateTracker,
	buildCompactionContext,
	formatCompactionAttachments,
	truncateCompactionContext,
	type TaskFocusState,
	type CompactionContext,
} from './compaction.js'
