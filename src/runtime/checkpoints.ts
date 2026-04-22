import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readFileText, writeFileAtomic, ensureDir, dirExists, listDirEntries } from '../shared/fs.js'
import type { QualityGrade } from './quality-score.js'

export interface CheckpointTodo {
	status: string
	content: string
}

export interface CheckpointRecord {
	trigger: string
	timestamp: number
	messageCount: number
	totalChars: number
	activeFiles: string[]
	recentDecisions: string[]
	pendingTodos: string[]
	verificationSummaries: string[]
	// v2 richer fields
	qualityScore: number
	qualityGrade: QualityGrade | ''
	planSummary: string
	verificationContext: string
	taskSnapshots: Array<{ id: string; title: string; status: string }>
}

interface SessionCheckpointState {
	totalChars: number
	messageCount: number
	activeFiles: Set<string>
	recentDecisions: string[]
	pendingTodos: CheckpointTodo[]
	verificationSummaries: string[]
	firedThresholds: Set<number>
	checkpoints: CheckpointRecord[]
	// v2 fields
	qualityScore: number
	qualityGrade: QualityGrade | ''
	planSummary: string
	verificationContext: string
	taskSnapshots: Array<{ id: string; title: string; status: string }>
}

const DEFAULT_THRESHOLDS = [20, 35, 50, 65, 80]
const MAX_PERSISTED_CHECKPOINTS = 10
const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export class ProgressiveCheckpointManager {
	private readonly sessions = new Map<string, SessionCheckpointState>()
	private readonly persistDir: string | null
	private readonly maxCacheEntries = 50

	constructor(
		private readonly enabled: boolean = true,
		persistDir?: string,
	) {
		this.persistDir = persistDir ?? null
	}

	recordMessage(sessionID: string, chars: number): void {
		if (!this.enabled) return
		const state = this.getState(sessionID)
		state.messageCount += 1
		state.totalChars += Math.max(0, chars)
		this.maybeCapture(sessionID, state)
	}

	recordFileActivity(sessionID: string, filePath: string): void {
		if (!this.enabled) return
		if (!filePath.trim()) return
		const state = this.getState(sessionID)
		state.activeFiles.add(filePath.trim())
		while (state.activeFiles.size > 25) {
			const oldest = state.activeFiles.values().next().value
			if (!oldest) break
			state.activeFiles.delete(oldest)
		}
	}

	recordDecision(sessionID: string, decision: string): void {
		if (!this.enabled) return
		if (!decision.trim()) return
		const state = this.getState(sessionID)
		state.recentDecisions.push(decision.trim())
		while (state.recentDecisions.length > 20) state.recentDecisions.shift()
	}

	recordVerification(sessionID: string, summary: string): void {
		if (!this.enabled) return
		if (!summary.trim()) return
		const state = this.getState(sessionID)
		state.verificationSummaries.push(summary.trim())
		while (state.verificationSummaries.length > 10) state.verificationSummaries.shift()
		state.verificationContext = summary.trim()
	}

	updateTodos(sessionID: string, todos: CheckpointTodo[]): void {
		if (!this.enabled) return
		this.getState(sessionID).pendingTodos = todos.slice()
	}

	updateQuality(sessionID: string, score: number, grade: QualityGrade): void {
		if (!this.enabled) return
		const state = this.getState(sessionID)
		state.qualityScore = score
		state.qualityGrade = grade
	}

	updatePlan(sessionID: string, summary: string): void {
		if (!this.enabled) return
		const state = this.getState(sessionID)
		state.planSummary = summary.slice(0, 500)
	}

	updateTaskSnapshots(sessionID: string, tasks: Array<{ id: string; title: string; status: string }>): void {
		if (!this.enabled) return
		const state = this.getState(sessionID)
		state.taskSnapshots = tasks.slice(0, 20)
	}

	maybeCaptureOnQuality(sessionID: string, currentGrade: QualityGrade): void {
		if (!this.enabled) return
		if (currentGrade !== 'D' && currentGrade !== 'F') return
		const state = this.sessions.get(sessionID)
		if (!state) return
		const lastCapture = state.checkpoints[state.checkpoints.length - 1]
		if (lastCapture && Date.now() - lastCapture.timestamp < 60_000) return
		this.captureCheckpoint(sessionID, state, 'quality-degradation')
	}

	buildRestoreContext(sessionID: string): string | null {
		if (!this.enabled) return null
		const state = this.sessions.get(sessionID)
		if (!state) {
			// try loading from persisted
			return this.loadAndBuildRestoreContext(sessionID)
		}
		const best = this.selectBestCheckpoint(state.checkpoints)
		if (!best) return this.loadAndBuildRestoreContext(sessionID)
		return this.renderRestoreBlock(best)
	}

	reset(sessionID: string): void {
		if (!this.enabled) return
		this.sessions.delete(sessionID)
	}

	private getState(sessionID: string): SessionCheckpointState {
		let state = this.sessions.get(sessionID)
		if (!state) {
			state = {
				totalChars: 0,
				messageCount: 0,
				activeFiles: new Set<string>(),
				recentDecisions: [],
				pendingTodos: [],
				verificationSummaries: [],
				firedThresholds: new Set<number>(),
				checkpoints: [],
				qualityScore: 0,
				qualityGrade: '',
				planSummary: '',
				verificationContext: '',
				taskSnapshots: [],
			}
			this.sessions.set(sessionID, state)
			this.trimSessions()
		}
		return state
	}

	private maybeCapture(sessionID: string, state: SessionCheckpointState): void {
		const estimatedTokens = Math.ceil(state.totalChars / 4)
		const fillPercent = Math.round((estimatedTokens / 200_000) * 100)
		for (const threshold of DEFAULT_THRESHOLDS) {
			if (fillPercent < threshold || state.firedThresholds.has(threshold)) continue
			state.firedThresholds.add(threshold)
			this.captureCheckpoint(sessionID, state, `fill-${threshold}`)
		}
	}

	private captureCheckpoint(sessionID: string, state: SessionCheckpointState, trigger: string): void {
		const checkpoint: CheckpointRecord = {
			trigger,
			timestamp: Date.now(),
			messageCount: state.messageCount,
			totalChars: state.totalChars,
			activeFiles: Array.from(state.activeFiles),
			recentDecisions: state.recentDecisions.slice(),
			pendingTodos: state.pendingTodos
				.filter(todo => todo.status === 'pending' || todo.status === 'in_progress')
				.map(todo => todo.content),
			verificationSummaries: state.verificationSummaries.slice(),
			qualityScore: state.qualityScore,
			qualityGrade: state.qualityGrade,
			planSummary: state.planSummary,
			verificationContext: state.verificationContext,
			taskSnapshots: state.taskSnapshots.slice(),
		}
		state.checkpoints.push(checkpoint)
		while (state.checkpoints.length > 50) state.checkpoints.shift()

		this.persistCheckpoint(sessionID, checkpoint)
	}

	private persistCheckpoint(sessionID: string, checkpoint: CheckpointRecord): void {
		if (!this.persistDir) return
		try {
			const dir = join(this.persistDir, sessionID)
			ensureDir(dir)
			const filename = `${checkpoint.timestamp}-${checkpoint.trigger.replace(/[^a-zA-Z0-9-]/g, '_')}.json`
			writeFileAtomic(join(dir, filename), JSON.stringify(checkpoint, null, 2))
			this.prunePersisted(sessionID)
		} catch {
			// persist failures are non-fatal (V1, V5)
		}
	}

	private prunePersisted(sessionID: string): void {
		if (!this.persistDir) return
		const dir = join(this.persistDir, sessionID)
		if (!dirExists(dir)) return
		const entries = listDirEntries(dir)
			.filter(e => e.endsWith('.json'))
			.sort()
		while (entries.length > MAX_PERSISTED_CHECKPOINTS) {
			const oldest = entries.shift()
			if (!oldest) break
			try {
				rmSync(join(dir, oldest), { force: true })
			} catch {
				// ignore cleanup errors
			}
		}
	}

	private loadAndBuildRestoreContext(sessionID: string): string | null {
		if (!this.persistDir) return null
		const dir = join(this.persistDir, sessionID)
		if (!dirExists(dir)) return null

		const entries = listDirEntries(dir)
			.filter(e => e.endsWith('.json'))
			.sort()

		// Try loading the most recent valid checkpoint
		for (let i = entries.length - 1; i >= 0; i--) {
			const raw = readFileText(join(dir, entries[i]))
			if (!raw) continue
			try {
				const checkpoint = JSON.parse(raw) as CheckpointRecord
				// Validate it's a reasonable checkpoint
				if (typeof checkpoint.timestamp === 'number' && checkpoint.timestamp > 0) {
					// Check TTL
					if (Date.now() - checkpoint.timestamp > CHECKPOINT_TTL_MS) continue
					return this.renderRestoreBlock(checkpoint)
				}
			} catch {
				// corrupted data — skip (V5)
				continue
			}
		}

		return null
	}

	private renderRestoreBlock(checkpoint: CheckpointRecord): string {
		const lines = [`## Checkpoint Restore (${checkpoint.trigger})`]
		if (checkpoint.qualityScore > 0 || checkpoint.qualityGrade) {
			lines.push(`Quality: ${checkpoint.qualityScore}/100 [${checkpoint.qualityGrade || 'n/a'}]`)
		}
		if (checkpoint.planSummary) {
			lines.push(`Plan: ${checkpoint.planSummary.slice(0, 200)}`)
		}
		if (checkpoint.verificationContext) {
			lines.push(`Last verification: ${checkpoint.verificationContext.slice(0, 200)}`)
		}
		if (checkpoint.activeFiles.length > 0) {
			lines.push('', '### Active Files')
			for (const file of checkpoint.activeFiles.slice(-10)) lines.push(`- ${file}`)
		}
		if (checkpoint.recentDecisions.length > 0) {
			lines.push('', '### Recent Decisions')
			for (const decision of checkpoint.recentDecisions.slice(-8)) lines.push(`- ${decision}`)
		}
		if (checkpoint.pendingTodos.length > 0) {
			lines.push('', '### Pending Todos')
			for (const todo of checkpoint.pendingTodos) lines.push(`- ${todo}`)
		}
		if (checkpoint.taskSnapshots.length > 0) {
			lines.push('', '### Task Snapshots')
			for (const task of checkpoint.taskSnapshots) lines.push(`- ${task.id}[${task.status}] ${task.title}`)
		}
		if (checkpoint.verificationSummaries.length > 0) {
			lines.push('', '### Verification')
			for (const summary of checkpoint.verificationSummaries.slice(-5)) lines.push(`- ${summary}`)
		}
		return lines.join('\n')
	}

	private selectBestCheckpoint(checkpoints: CheckpointRecord[]): CheckpointRecord | null {
		if (checkpoints.length === 0) return null
		return checkpoints.reduce<CheckpointRecord | null>((best, checkpoint) => {
			if (!best) return checkpoint
			const bestScore = checkpointScore(best)
			const nextScore = checkpointScore(checkpoint)
			if (nextScore > bestScore) return checkpoint
			if (nextScore === bestScore && checkpoint.timestamp > best.timestamp) return checkpoint
			return best
		}, null)
	}

	private trimSessions(): void {
		while (this.sessions.size > this.maxCacheEntries) {
			const oldest = this.sessions.keys().next().value
			if (!oldest) break
			this.sessions.delete(oldest)
		}
	}
}

function checkpointScore(checkpoint: CheckpointRecord): number {
	return (
		checkpoint.messageCount * 10 +
		checkpoint.activeFiles.length * 4 +
		checkpoint.recentDecisions.length * 3 +
		checkpoint.pendingTodos.length * 3 +
		checkpoint.verificationSummaries.length * 2 +
		(checkpoint.qualityScore > 0 ? 5 : 0) +
		checkpoint.taskSnapshots.length * 2
	)
}
