export interface SearchMatch {
	filePath: string
	lineNumber: number
	line: string
}

export interface GroupedSearchResult {
	filePath: string
	matches: Array<{ lineNumber: number; line: string }>
}

const MAX_MATCHES_PER_FILE = 20
const MAX_LINE_LENGTH = 200
const MAX_TOTAL_GROUPS = 30

export function renderSearchResults(
	matches: SearchMatch[],
	options: {
		maxLineLength?: number
		maxMatchesPerFile?: number
		maxGroups?: number
		contextLines?: number
		query?: string
		includePattern?: string
	} = {},
): string {
	if (matches.length === 0) {
		return options.query ? `No matches found for: ${options.query}` : 'No matches found.'
	}

	const maxLineLen = options.maxLineLength ?? MAX_LINE_LENGTH
	const maxPerFile = options.maxMatchesPerFile ?? MAX_MATCHES_PER_FILE
	const maxGroups = options.maxGroups ?? MAX_TOTAL_GROUPS

	const groups = groupMatches(matches, maxPerFile, maxGroups)

	const lines: string[] = []
	if (options.query) lines.push(`## Search Results: ${options.query}`, '')
	if (options.includePattern) lines.push(`Filter: ${options.includePattern}`, '')

	let totalShown = 0
	for (const group of groups) {
		if (totalShown >= maxGroups) break
		lines.push(`### ${group.filePath} (${group.matches.length} match${group.matches.length > 1 ? 'es' : ''})`)
		for (const match of group.matches) {
			const clipped = clipLine(match.line, maxLineLen)
			lines.push(`  L${match.lineNumber}: ${clipped}`)
		}
		lines.push('')
		totalShown++
	}

	const total = matches.length
	if (total > totalShown * maxPerFile) {
		lines.push(`... and ${total - totalShown * maxPerFile} more matches`)
	}

	return lines.join('\n')
}

export function renderGroupedGrepOutput(
	rawOutput: string,
	options: {
		maxLineLength?: number
		maxMatchesPerFile?: number
		maxGroups?: number
		query?: string
		includePattern?: string
	} = {},
): string {
	const matches = parseGrepOutput(rawOutput)
	if (matches.length === 0) return rawOutput
	return renderSearchResults(matches, options)
}

export function groupMatches(
	matches: SearchMatch[],
	maxPerFile: number = MAX_MATCHES_PER_FILE,
	maxGroups: number = MAX_TOTAL_GROUPS,
): GroupedSearchResult[] {
	const map = new Map<string, SearchMatch[]>()

	for (const match of matches) {
		let group = map.get(match.filePath)
		if (!group) {
			group = []
			map.set(match.filePath, group)
		}
		if (group.length < maxPerFile) {
			group.push(match)
		}
	}

	const result: GroupedSearchResult[] = []
	for (const [filePath, fileMatches] of map) {
		if (result.length >= maxGroups) break
		result.push({
			filePath,
			matches: fileMatches.map(m => ({ lineNumber: m.lineNumber, line: m.line })),
		})
	}

	return result
}

export function parseGrepOutput(rawOutput: string): SearchMatch[] {
	const matches: SearchMatch[] = []
	if (!rawOutput.trim()) return matches

	for (const rawLine of rawOutput.split('\n')) {
		const line = rawLine.trim()
		if (!line) continue

		// rg format: filepath:linenum:content or filepath:content
		const colonIdx = line.indexOf(':')
		if (colonIdx < 0) continue
		const filePath = line.slice(0, colonIdx)
		const rest = line.slice(colonIdx + 1)

		const secondColon = rest.indexOf(':')
		if (secondColon < 0) {
			// filepath:content (no line number)
			matches.push({ filePath, lineNumber: 0, line: rest })
			continue
		}

		const lineNum = parseInt(rest.slice(0, secondColon), 10)
		const content = rest.slice(secondColon + 1)
		if (!Number.isFinite(lineNum)) {
			matches.push({ filePath, lineNumber: 0, line: rest })
			continue
		}

		matches.push({ filePath, lineNumber: lineNum, line: content })
	}

	return matches
}

export function clipLine(line: string, maxLength: number = MAX_LINE_LENGTH): string {
	const trimmed = line.replace(/\t/g, '  ').trim()
	if (trimmed.length <= maxLength) return trimmed
	return trimmed.slice(0, maxLength - 3) + '...'
}
