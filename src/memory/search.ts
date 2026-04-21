import { scanMemoryFiles, type MemoryHeader } from './scan.js'
import { searchCaveMemProject } from './cavemem.js'

export interface ProjectMemorySearchOptions {
	includeCavemem?: boolean
	cavememDataDir?: string
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
	const legacy = findRelevantMemories(query, cwd, maxResults * 2).map((header, index) => ({
		header,
		score: maxResults * 2 - index,
	}))
	const cavemem = options.includeCavemem
		? searchCaveMemProject(query, cwd, maxResults * 2, { dataDir: options.cavememDataDir })
		: []

	const merged = new Map<string, { header: MemoryHeader; score: number }>()
	for (const entry of legacy) {
		merged.set(entry.header.path, entry)
	}
	for (const entry of cavemem) {
		const existing = merged.get(entry.path)
		if (!existing || entry.score > existing.score) {
			merged.set(entry.path, { header: entry, score: entry.score })
		}
	}

	return Array.from(merged.values())
		.sort((a, b) => b.score - a.score || b.header.modifiedAt - a.header.modifiedAt)
		.slice(0, maxResults)
		.map(entry => entry.header)
}

function tokenize(text: string): Set<string> {
	const asciiTokens = new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t: string) => t.length >= 3))
	const hanChars = new Set(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [])
	return new Set([...asciiTokens, ...hanChars])
}
