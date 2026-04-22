import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileExists } from '../shared/fs.js'
import type { QualityGrade } from './quality-score.js'

export type PrimerTier = 'cold' | 'warm' | 'hot'

export interface SessionPrimerOptions {
	enabled?: boolean
	maxTopFiles?: number
	cacheTtlMs?: number
}

export interface SessionPrimerSnapshot {
	gitBranch: string | null
	changedFilesCount: number
	specPresent: boolean
	planMode: string
	currentTarget: string
	nextStep: string
	graphStatus: string
	graphFreshness: string
	topFiles: string[]
	tier: PrimerTier
	graphFileCount: number
	graphSymbolCount: number
	pendingTodoCount: number
	latestVerificationStatus: string
	qualityGrade: QualityGrade | ''
	cachedAt: number
}

export interface SessionPrimerGraphSource {
	getStatus(): { state: string; ready: boolean; stats?: { files: number; symbols: number } }
	getTopFiles(limit?: number): Array<{ path: string }>
}

const DEFAULT_CACHE_TTL_MS = 60_000

export class SessionPrimer {
	private readonly enabled: boolean
	private readonly maxTopFiles: number
	private readonly cacheTtlMs: number
	private readonly cache = new Map<string, { snapshot: SessionPrimerSnapshot; cachedAt: number }>()
	private readonly maxCacheEntries = 50

	constructor(options: SessionPrimerOptions = {}) {
		this.enabled = options.enabled === true
		this.maxTopFiles = options.maxTopFiles ?? 3
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
	}

	isEnabled(): boolean {
		return this.enabled
	}

	buildSnapshot(input: {
		cwd: string
		planMode?: string
		currentTarget?: string
		nextStep?: string
		graph?: SessionPrimerGraphSource | null
		pendingTodoCount?: number
		latestVerificationStatus?: string
		qualityGrade?: QualityGrade | ''
	}): SessionPrimerSnapshot {
		const graphStatusObj = input.graph?.getStatus()
		const graphStatus = graphStatusObj?.state ?? 'unavailable'
		const graphReady = graphStatusObj?.ready ?? false
		const graphFileCount = graphStatusObj?.stats?.files ?? 0
		const graphSymbolCount = graphStatusObj?.stats?.symbols ?? 0
		const topFiles = graphReady ? input.graph!.getTopFiles(this.maxTopFiles).map(file => file.path) : []

		const changedFilesCount = countChangedFiles(input.cwd)
		const specPresent = fileExists(join(input.cwd, 'SPEC.md'))

		const tier = computeTier({
			graphReady,
			graphFileCount,
			changedFilesCount,
			specPresent,
			pendingTodoCount: input.pendingTodoCount ?? 0,
			verificationStatus: input.latestVerificationStatus ?? '',
		})

		const graphFreshness = describeGraphFreshness(graphStatus, graphFileCount)

		return {
			gitBranch: readGitBranch(input.cwd),
			changedFilesCount,
			specPresent,
			planMode: input.planMode?.trim() || 'ad-hoc',
			currentTarget: input.currentTarget?.trim() || '',
			nextStep: input.nextStep?.trim() || '',
			graphStatus,
			graphFreshness,
			topFiles,
			tier,
			graphFileCount,
			graphSymbolCount,
			pendingTodoCount: input.pendingTodoCount ?? 0,
			latestVerificationStatus: input.latestVerificationStatus ?? '',
			qualityGrade: input.qualityGrade ?? '',
			cachedAt: Date.now(),
		}
	}

	getCachedOrBuild(sessionID: string, input: Parameters<SessionPrimer['buildSnapshot']>[0]): SessionPrimerSnapshot {
		const cached = this.cache.get(sessionID)
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached.snapshot
		}

		const snapshot = this.buildSnapshot(input)
		this.cache.set(sessionID, { snapshot, cachedAt: Date.now() })
		this.trimCache()
		return snapshot
	}

	render(snapshot: SessionPrimerSnapshot): string {
		const lines = ['# Session Primer', '', `Tier: ${snapshot.tier}`, `Plan mode: ${snapshot.planMode}`]
		lines.push(`SPEC.md: ${snapshot.specPresent ? 'present' : 'missing'}`)
		lines.push(`Git branch: ${snapshot.gitBranch ?? 'n/a'}`)
		lines.push(`Changed files: ${snapshot.changedFilesCount}`)
		lines.push(`Graph: ${snapshot.graphStatus} (${snapshot.graphFreshness})`)
		if (snapshot.graphFileCount > 0) {
			lines.push(`Graph stats: ${snapshot.graphFileCount} files, ${snapshot.graphSymbolCount} symbols`)
		}
		if (snapshot.pendingTodoCount > 0) {
			lines.push(`Pending todos: ${snapshot.pendingTodoCount}`)
		}
		if (snapshot.latestVerificationStatus) {
			lines.push(`Last verification: ${snapshot.latestVerificationStatus}`)
		}
		if (snapshot.qualityGrade) {
			lines.push(`Quality: ${snapshot.qualityGrade}`)
		}
		if (snapshot.currentTarget) lines.push(`Current target: ${snapshot.currentTarget}`)
		if (snapshot.nextStep) lines.push(`Next step: ${snapshot.nextStep}`)
		if (snapshot.topFiles.length > 0) {
			lines.push('', '## Graph hints')
			for (const file of snapshot.topFiles) lines.push(`- ${file}`)
		}
		return lines.join('\n')
	}

	renderCompact(snapshot: SessionPrimerSnapshot): string {
		const parts = [`tier=${snapshot.tier}`, `mode=${snapshot.planMode}`]
		if (snapshot.gitBranch) parts.push(`branch=${snapshot.gitBranch}`)
		if (snapshot.changedFilesCount > 0) parts.push(`changes=${snapshot.changedFilesCount}`)
		if (snapshot.graphFileCount > 0) parts.push(`graph=${snapshot.graphFileCount}f/${snapshot.graphSymbolCount}s`)
		if (snapshot.qualityGrade) parts.push(`quality=${snapshot.qualityGrade}`)
		return parts.join(' | ')
	}

	reset(sessionID: string): void {
		this.cache.delete(sessionID)
	}

	private trimCache(): void {
		while (this.cache.size > this.maxCacheEntries) {
			const oldest = this.cache.keys().next().value
			if (!oldest) break
			this.cache.delete(oldest)
		}
	}
}

function computeTier(input: {
	graphReady: boolean
	graphFileCount: number
	changedFilesCount: number
	specPresent: boolean
	pendingTodoCount: number
	verificationStatus: string
}): PrimerTier {
	let score = 0
	if (input.graphReady) score += 3
	if (input.graphFileCount > 50) score += 1
	if (input.specPresent) score += 2
	if (input.verificationStatus === 'pass') score += 2
	if (input.verificationStatus === 'fail') score -= 1
	if (input.pendingTodoCount > 5) score -= 1
	if (input.changedFilesCount > 20) score -= 1

	if (score >= 6) return 'hot'
	if (score >= 3) return 'warm'
	return 'cold'
}

function describeGraphFreshness(state: string, fileCount: number): string {
	if (state === 'ready') return `fresh (${fileCount} indexed)`
	if (state === 'stale') return 'stale — rescan recommended'
	if (state === 'scanning') return 'scanning...'
	if (state === 'error') return 'error'
	return 'unavailable'
}

function readGitBranch(cwd: string): string | null {
	const result = spawnSync('git', ['branch', '--show-current'], {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 1000,
	})
	const branch = result.stdout?.trim() ?? ''
	return branch || null
}

function countChangedFiles(cwd: string): number {
	const result = spawnSync('git', ['status', '--porcelain'], {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 1000,
	})
	const body = result.stdout?.trim() ?? ''
	return body ? body.split('\n').filter(Boolean).length : 0
}
