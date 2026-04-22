import { scanMemoryFiles, type MemoryHeader } from './scan.js'
import { searchCaveMemProject } from './cavemem.js'

export interface ProjectMemorySearchOptions {
	includeCavemem?: boolean
	cavememDataDir?: string
	searchAlpha?: number
	embeddingProvider?: string
	defaultLimit?: number
}

export function findRelevantMemories(query: string, cwd: string, maxResults: number = 5): MemoryHeader[] {
	const tokens = Array.from(tokenize(query))
	if (!tokens.length) return []

	const scored: Array<[number, MemoryHeader]> = []

	for (const header of scanMemoryFiles(cwd, 100)) {
		const title = header.title.toLowerCase()
		const meta = `${header.title} ${header.description}`.toLowerCase()
		const body = header.bodyPreview.toLowerCase()

		const titleHits = tokens.reduce((n: number, t: string) => n + (title.includes(t) ? 1 : 0), 0)
		const metaHits = tokens.reduce((n: number, t: string) => n + (meta.includes(t) ? 1 : 0), 0)
		const bodyHits = tokens.reduce((n: number, t: string) => n + (body.includes(t) ? 1 : 0), 0)
		const score = titleHits * 4 + metaHits * 2 + bodyHits

		if (score > 0) scored.push([score, header])
	}

	scored.sort((a, b) => b[0] - a[0])
	return scored.slice(0, maxResults).map(([, h]) => h)
}

export function findRelevantProjectMemories(
	query: string,
	cwd: string,
	maxResults: number = 5,
	options: ProjectMemorySearchOptions = {},
): MemoryHeader[] {
	const limit = maxResults > 0 ? maxResults : (options.defaultLimit ?? 5)
	const alpha = clampAlpha(options.searchAlpha)
	const legacy = findRelevantMemories(query, cwd, limit * 2).map((header, index, list) => ({
		header,
		score: normalizeRankScore(index, list.length) * (1 - alpha),
	}))
	const cavemem = options.includeCavemem
		? searchCaveMemProject(query, cwd, limit * 2, {
				dataDir: options.cavememDataDir,
				embeddingProvider: options.embeddingProvider,
				searchAlpha: options.searchAlpha,
				searchDefaultLimit: options.defaultLimit,
			})
		: []
	const cavememWeighted = cavemem.map((header, index, list) => ({
		header,
		score: normalizeRankScore(index, list.length) * alpha,
	}))

	const merged = new Map<string, { header: MemoryHeader; score: number }>()
	for (const entry of legacy) {
		merged.set(entry.header.path, entry)
	}
	for (const entry of cavememWeighted) {
		const existing = merged.get(entry.header.path)
		if (!existing) {
			merged.set(entry.header.path, entry)
			continue
		}
		merged.set(entry.header.path, {
			header: existing.header.memoryType.startsWith('cavemem:') ? existing.header : entry.header,
			score: existing.score + entry.score,
		})
	}

	return Array.from(merged.values())
		.sort((a, b) => b.score - a.score || b.header.modifiedAt - a.header.modifiedAt)
		.slice(0, limit)
		.map(entry => entry.header)
}

function normalizeRankScore(index: number, length: number): number {
	if (length <= 0) return 0
	return (length - index) / length
}

function clampAlpha(alpha: number | undefined): number {
	if (typeof alpha !== 'number' || !Number.isFinite(alpha)) return 0.65
	return Math.min(1, Math.max(0, alpha))
}

function tokenize(text: string): Set<string> {
	const asciiTokens = new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t: string) => t.length >= 3))
	const hanChars = new Set(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [])
	return new Set([...asciiTokens, ...hanChars])
}
