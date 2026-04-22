import { findRelevantProjectMemories } from '../memory/search.js'
import type { MemoryHeader } from '../memory/scan.js'
import type { LoadedCompatPlugin } from '../shared/types.js'

export interface TaskFocusState {
	goal: string
	recentGoals: string[]
	activeArtifacts: string[]
	verifiedState: string[]
	nextStep: string
}

export interface CompactionContext {
	taskFocus: TaskFocusState | null
	recentWorkLog: string[]
	recentVerifiedWork: string[]
	executionPlanSummary: string
	executionPhase: string
	runtimeVerification: string[]
	invokedSkills: string[]
	relevantMemories: MemoryHeader[]
	activePlugins: Array<{ name: string; version: string }>
}

export function buildCompactionContext(opts: {
	cwd: string
	lastPrompt: string
	plugins: LoadedCompatPlugin[]
	invokedSkills: string[]
	sessionState: SessionStateTracker
	relevantMemories?: MemoryHeader[]
	executionPlanSummary?: string
	executionPhase?: string
	runtimeVerification?: string[]
	includeCavemem?: boolean
	cavememDataDir?: string
	searchAlpha?: number
	embeddingProvider?: string
	searchDefaultLimit?: number
}): CompactionContext {
	const {
		cwd,
		lastPrompt,
		plugins,
		invokedSkills,
		sessionState,
		relevantMemories,
		executionPlanSummary,
		executionPhase,
		runtimeVerification,
		includeCavemem,
		cavememDataDir,
		searchAlpha,
		embeddingProvider,
		searchDefaultLimit,
	} = opts

	const memories =
		relevantMemories ??
		(lastPrompt
			? findRelevantProjectMemories(lastPrompt, cwd, 3, {
					includeCavemem,
					cavememDataDir,
					searchAlpha,
					embeddingProvider,
					defaultLimit: searchDefaultLimit,
				})
			: [])

	return {
		taskFocus: sessionState.getTaskFocus(),
		recentWorkLog: sessionState.getRecentWorkLog(),
		recentVerifiedWork: sessionState.getRecentVerifiedWork(),
		executionPlanSummary: executionPlanSummary ?? '',
		executionPhase: executionPhase ?? '',
		runtimeVerification: runtimeVerification ?? [],
		invokedSkills,
		relevantMemories: memories,
		activePlugins: plugins
			.filter(p => p.enabled)
			.map(p => ({ name: p.manifest.name, version: p.manifest.version })),
	}
}

export function formatCompactionAttachments(ctx: CompactionContext): string {
	const parts: string[] = []

	if (ctx.taskFocus && (ctx.taskFocus.goal || ctx.taskFocus.nextStep)) {
		const lines: string[] = ['[Compact attachment: task focus]']
		if (ctx.taskFocus.goal) lines.push(`Goal: ${ctx.taskFocus.goal}`)
		if (ctx.taskFocus.nextStep) lines.push(`Next step: ${ctx.taskFocus.nextStep}`)
		if (ctx.taskFocus.activeArtifacts.length > 0) {
			lines.push(`Active artifacts: ${ctx.taskFocus.activeArtifacts.join(', ')}`)
		}
		if (ctx.taskFocus.verifiedState.length > 0) {
			lines.push(`Verified: ${ctx.taskFocus.verifiedState.slice(-5).join('; ')}`)
		}
		parts.push(lines.join('\n'))
	}

	if (ctx.recentWorkLog.length > 0) {
		const lines = ['[Compact attachment: recent work log]']
		lines.push(...ctx.recentWorkLog.slice(-8))
		parts.push(lines.join('\n'))
	}

	if (ctx.recentVerifiedWork.length > 0) {
		const lines = ['[Compact attachment: recent verification]']
		lines.push(...ctx.recentVerifiedWork.slice(-5))
		parts.push(lines.join('\n'))
	}

	if (ctx.relevantMemories.length > 0) {
		const lines = ['[Compact attachment: relevant memories]']
		for (const m of ctx.relevantMemories) {
			lines.push(`- ${m.title}: ${m.description.slice(0, 120)}`)
		}
		parts.push(lines.join('\n'))
	}

	if (ctx.executionPlanSummary || ctx.executionPhase || ctx.runtimeVerification.length > 0) {
		const lines = ['[Compact attachment: execution runtime]']
		if (ctx.executionPhase) lines.push(`Phase: ${ctx.executionPhase}`)
		if (ctx.executionPlanSummary) lines.push(`Plan: ${ctx.executionPlanSummary}`)
		if (ctx.runtimeVerification.length > 0) {
			lines.push(`Verify: ${ctx.runtimeVerification.slice(-3).join('; ')}`)
		}
		parts.push(lines.join('\n'))
	}

	if (ctx.invokedSkills.length > 0) {
		parts.push(`[Compact attachment: invoked skills]\nSkills used: ${ctx.invokedSkills.join(', ')}`)
	}

	if (ctx.activePlugins.length > 0) {
		const pluginList = ctx.activePlugins.map(p => `${p.name}@${p.version}`).join(', ')
		parts.push(`[Compact attachment: active plugins]\n${pluginList}`)
	}

	return parts.join('\n\n')
}

const MAX_CHARS = 4000
const TRUNCATION_SUFFIX = '\n[...truncated]'

export function truncateCompactionContext(formatted: string, maxChars: number = MAX_CHARS): string {
	if (maxChars <= 0) return ''
	if (formatted.length <= maxChars) return formatted
	if (maxChars <= TRUNCATION_SUFFIX.length) return TRUNCATION_SUFFIX.slice(0, maxChars)
	return formatted.slice(0, maxChars - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
}

export function buildCompactionPayload(parts: Array<string | null | undefined>, maxChars: number = MAX_CHARS): string {
	let payload = ''

	for (const part of parts) {
		const normalized = part?.trim()
		if (!normalized) continue

		const separator = payload ? '\n\n' : ''
		const next = `${payload}${separator}${normalized}`
		if (next.length <= maxChars) {
			payload = next
			continue
		}

		const remaining = maxChars - payload.length - separator.length
		if (remaining <= 0) break

		const truncated = truncateCompactionContext(normalized, remaining)
		if (!truncated) break
		payload = `${payload}${separator}${truncated}`
		break
	}

	return payload
}

export class SessionStateTracker {
	private goal = ''
	private recentGoals: string[] = []
	private activeArtifacts: string[] = []
	private verifiedState: string[] = []
	private nextStep = ''
	private workLog: string[] = []
	private maxEntries: number

	constructor(maxEntries: number = 10) {
		this.maxEntries = maxEntries
	}

	updateGoal(goal: string): void {
		if (goal && goal !== this.goal) {
			if (this.goal) {
				this.recentGoals.push(this.goal)
				if (this.recentGoals.length > 5) this.recentGoals.shift()
			}
			this.goal = goal
		}
	}

	addArtifact(artifact: string): void {
		if (!artifact) return
		const idx = this.activeArtifacts.indexOf(artifact)
		if (idx !== -1) this.activeArtifacts.splice(idx, 1)
		this.activeArtifacts.push(artifact)
		if (this.activeArtifacts.length > 8) this.activeArtifacts.shift()
	}

	addVerifiedState(state: string): void {
		if (!state) return
		this.verifiedState.push(state)
		if (this.verifiedState.length > 10) this.verifiedState.shift()
	}

	setNextStep(step: string): void {
		this.nextStep = step
	}

	addWorkLogEntry(entry: string): void {
		if (!entry) return
		this.workLog.push(entry)
		if (this.workLog.length > this.maxEntries) this.workLog.shift()
	}

	getTaskFocus(): TaskFocusState {
		return {
			goal: this.goal,
			recentGoals: [...this.recentGoals],
			activeArtifacts: [...this.activeArtifacts],
			verifiedState: [...this.verifiedState],
			nextStep: this.nextStep,
		}
	}

	getRecentWorkLog(): string[] {
		return [...this.workLog]
	}

	getRecentVerifiedWork(): string[] {
		return [...this.verifiedState]
	}

	reset(): void {
		this.goal = ''
		this.recentGoals = []
		this.activeArtifacts = []
		this.verifiedState = []
		this.nextStep = ''
		this.workLog = []
	}
}
