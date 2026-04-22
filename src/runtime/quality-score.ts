export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface QualitySignals {
	repeatedReads: number
	largeOutputCount: number
	archivePressure: number
	compactionCount: number
	verificationPassRate: number
	verificationTotal: number
	todoPressure: number
	phaseCycles: number
}

export interface QualityScoreResult {
	score: number
	grade: QualityGrade
	signals: QualitySignals
	breakdown: Array<{ signal: string; penalty: number; description: string }>
	summary: string
}

export interface QualityNudge {
	message: string
	cooldownMs: number
	priority: 'info' | 'warn'
}

const MAX_SCORE = 100
const CACHE_TTL_MS = 30_000

export class QualityScorer {
	private readonly cache = new Map<string, { result: QualityScoreResult; cachedAt: number }>()
	private readonly nudgeCooldown = new Map<string, { nudgeKey: string; firedAt: number }>()
	private readonly maxCacheEntries = 50

	constructor(private readonly options: { enabled?: boolean } = {}) {}

	isEnabled(): boolean {
		return this.options.enabled === true
	}

	score(signals: QualitySignals): QualityScoreResult {
		const breakdown: Array<{ signal: string; penalty: number; description: string }> = []
		let penalty = 0

		// repeated reads penalty
		if (signals.repeatedReads > 5) {
			const p = Math.min(20, (signals.repeatedReads - 5) * 3)
			penalty += p
			breakdown.push({
				signal: 'repeatedReads',
				penalty: p,
				description: `${signals.repeatedReads} repeated reads detected`,
			})
		}

		// large output count
		if (signals.largeOutputCount > 3) {
			const p = Math.min(15, (signals.largeOutputCount - 3) * 3)
			penalty += p
			breakdown.push({
				signal: 'largeOutputCount',
				penalty: p,
				description: `${signals.largeOutputCount} large outputs`,
			})
		}

		// archive pressure
		if (signals.archivePressure > 5) {
			const p = Math.min(10, (signals.archivePressure - 5) * 2)
			penalty += p
			breakdown.push({
				signal: 'archivePressure',
				penalty: p,
				description: `${signals.archivePressure} archived outputs`,
			})
		}

		// compaction count
		if (signals.compactionCount > 2) {
			const p = Math.min(15, (signals.compactionCount - 2) * 5)
			penalty += p
			breakdown.push({
				signal: 'compactionCount',
				penalty: p,
				description: `${signals.compactionCount} compactions`,
			})
		}

		// verification pass rate
		if (signals.verificationTotal >= 2) {
			const passRate = signals.verificationPassRate / signals.verificationTotal
			if (passRate < 0.5) {
				const p = Math.round(Math.min(25, (1 - passRate) * 30))
				penalty += p
				breakdown.push({
					signal: 'verificationPassRate',
					penalty: p,
					description: `${(passRate * 100).toFixed(0)}% pass rate (${signals.verificationPassRate}/${signals.verificationTotal})`,
				})
			}
		}

		// todo pressure
		if (signals.todoPressure > 5) {
			const p = Math.min(10, (signals.todoPressure - 5) * 2)
			penalty += p
			breakdown.push({ signal: 'todoPressure', penalty: p, description: `${signals.todoPressure} pending todos` })
		}

		// phase cycles
		if (signals.phaseCycles > 3) {
			const p = Math.min(10, (signals.phaseCycles - 3) * 3)
			penalty += p
			breakdown.push({ signal: 'phaseCycles', penalty: p, description: `${signals.phaseCycles} phase cycles` })
		}

		const score = Math.max(0, MAX_SCORE - penalty)
		const grade = scoreToGrade(score)
		const summary = buildQualitySummary(score, grade, breakdown)

		return { score, grade, signals, breakdown, summary }
	}

	getCachedOrScore(cacheKey: string, signals: QualitySignals): QualityScoreResult {
		const cached = this.cache.get(cacheKey)
		if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.result

		const result = this.score(signals)
		this.cache.set(cacheKey, { result, cachedAt: Date.now() })
		this.trimCache()
		return result
	}

	getNudge(sessionID: string, result: QualityScoreResult): QualityNudge | null {
		if (!this.options.enabled) return null
		if (result.grade === 'A' || result.grade === 'B') return null

		const worstSignal = result.breakdown.sort((a, b) => b.penalty - a.penalty)[0]
		if (!worstSignal) return null

		const nudgeKey = `${worstSignal.signal}-${result.grade}`
		const cooldown = this.nudgeCooldown.get(sessionID)
		if (cooldown && cooldown.nudgeKey === nudgeKey && Date.now() - cooldown.firedAt < 120_000) return null

		const messages: Record<string, string> = {
			repeatedReads: `Quality hint: ${worstSignal.description}. Consider using delta reads or targeted file searches.`,
			largeOutputCount: `Quality hint: ${worstSignal.description}. Large outputs increase token pressure; consider archiving.`,
			archivePressure: `Quality hint: ${worstSignal.description}. Archived outputs may need cleanup.`,
			compactionCount: `Quality hint: ${worstSignal.description}. Frequent compactions suggest session context is growing fast.`,
			verificationPassRate: `Quality hint: ${worstSignal.description}. Check if test failures need fixing before continuing.`,
			todoPressure: `Quality hint: ${worstSignal.description}. Consider resolving pending todos before adding new work.`,
			phaseCycles: `Quality hint: ${worstSignal.description}. Frequent phase cycling may indicate unclear task scope.`,
		}

		const message = messages[worstSignal.signal] ?? `Quality hint: ${worstSignal.description}`
		this.nudgeCooldown.set(sessionID, { nudgeKey, firedAt: Date.now() })

		return {
			message,
			cooldownMs: 120_000,
			priority: result.grade === 'D' || result.grade === 'F' ? 'warn' : 'info',
		}
	}

	renderQuality(result: QualityScoreResult): string {
		const lines: string[] = ['## Session Quality', '', `Score: ${result.score}/100 (grade ${result.grade})`]
		if (result.breakdown.length > 0) {
			lines.push('', '### Signal breakdown')
			for (const entry of result.breakdown) {
				lines.push(`- ${entry.signal}: -${entry.penalty} (${entry.description})`)
			}
		} else {
			lines.push('', 'No quality penalties detected.')
		}
		return lines.join('\n')
	}

	renderCompactSummary(result: QualityScoreResult): string {
		return `quality: ${result.score}/100 [${result.grade}]${result.breakdown.length > 0 ? ` — ${result.breakdown[0].description}` : ''}`
	}

	reset(sessionID: string): void {
		this.cache.delete(sessionID)
		this.nudgeCooldown.delete(sessionID)
	}

	private trimCache(): void {
		while (this.cache.size > this.maxCacheEntries) {
			const oldest = this.cache.keys().next().value
			if (!oldest) break
			this.cache.delete(oldest)
		}
	}
}

function scoreToGrade(score: number): QualityGrade {
	if (score >= 90) return 'A'
	if (score >= 75) return 'B'
	if (score >= 60) return 'C'
	if (score >= 40) return 'D'
	return 'F'
}

function buildQualitySummary(
	score: number,
	grade: QualityGrade,
	breakdown: Array<{ signal: string; penalty: number }>,
): string {
	if (breakdown.length === 0) return `Session quality: ${score}/100 [${grade}] — healthy`
	const top = breakdown.sort((a, b) => b.penalty - a.penalty)[0]
	return `Session quality: ${score}/100 [${grade}] — top penalty: ${top.signal} (-${top.penalty})`
}
