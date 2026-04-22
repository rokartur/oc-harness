import type { CompiledPrompt } from './types.js'

export type CaveKitSection = 'goal' | 'constraints' | 'interfaces' | 'invariants' | 'tasks' | 'bugs'

export interface CaveKitTask {
	id: string
	status: string
	task: string
	cites: string[]
	line: string
}

export interface ParsedCaveKitSpec {
	goal: string
	constraints: string[]
	interfaces: string[]
	invariants: string[]
	tasks: CaveKitTask[]
	taskHeader: string
	bugHeader: string
	bugRows: string[][]
	sections: Partial<Record<CaveKitSection, string>>
}

export interface CaveKitSpecValidationResult {
	valid: boolean
	reasons: string[]
}

const SECTION_LABELS: Record<CaveKitSection, string> = {
	goal: '§G GOAL',
	constraints: '§C CONSTRAINTS',
	interfaces: '§I INTERFACES',
	invariants: '§V INVARIANTS',
	tasks: '§T TASKS',
	bugs: '§B BUGS',
}

export function parseCaveKitSpec(content: string): ParsedCaveKitSpec {
	const sections = collectSections(content)
	const goal = firstMeaningfulLine(sections.goal ?? '')
	const constraints = parseListLines(sections.constraints ?? '')
	const interfaces = parseListLines(sections.interfaces ?? '')
	const invariants = parseListLines(sections.invariants ?? '')
	const { header: taskHeader, rows: taskRows } = parseTableSection(sections.tasks ?? '', 'id|status|task|cites')
	const { header: bugHeader, rows: bugRows } = parseTableSection(sections.bugs ?? '', 'id|date|cause|fix')

	return {
		goal,
		constraints,
		interfaces,
		invariants,
		tasks: taskRows
			.map(row => ({
				id: row[0] ?? '',
				status: normalizeTaskStatus(row[1] ?? '.'),
				task: row[2] ?? '',
				cites: splitCitations(row[3] ?? ''),
				line: row.join('|'),
			}))
			.filter(task => /^T\d+$/i.test(task.id) && task.task.trim().length > 0),
		taskHeader,
		bugHeader,
		bugRows,
		sections,
	}
}

export function selectCaveKitTasks(tasks: CaveKitTask[], prompt: CompiledPrompt, limit: number = 3): CaveKitTask[] {
	const openTasks = tasks.filter(task => task.status !== 'x')
	if (openTasks.length === 0) return []

	const activeTasks = openTasks.filter(task => task.status === '~')
	const candidates = activeTasks.length > 0 ? activeTasks : openTasks.filter(task => task.status === '.')
	const matched = rankTasks(candidates, prompt).filter(entry => entry.score > 0)

	if (matched.length > 0) return matched.slice(0, limit).map(entry => entry.task)
	return candidates.slice(0, limit)
}

export function extractSpecValidationCommands(spec: ParsedCaveKitSpec): string[] {
	const corpus = [
		spec.goal,
		...spec.constraints,
		...spec.interfaces,
		...spec.invariants,
		...spec.tasks.map(task => `${task.task} ${task.cites.join(' ')}`),
	].join('\n')

	const patterns = [
		/\bbun(?:\s+run)?\s+(?:test|check|typecheck|build|lint)\b/gi,
		/\bnpm\s+run\s+(?:test|check|typecheck|build|lint)\b/gi,
		/\bpnpm\s+(?:test|check|typecheck|build|lint)\b/gi,
		/\byarn\s+(?:test|check|typecheck|build|lint)\b/gi,
		/\bpytest\b/gi,
	]

	const found = new Set<string>()
	for (const pattern of patterns) {
		for (const match of corpus.matchAll(pattern)) {
			const command = match[0]?.trim()
			if (command) found.add(command)
		}
	}

	return Array.from(found).slice(0, 3)
}

export function replaceCaveKitSection(content: string, section: CaveKitSection, body: string): string {
	const heading = SECTION_LABELS[section]
	const pattern = new RegExp(`(##\\s+${escapeRegex(heading)}\\n)([\\s\\S]*?)(?=\\n##\\s+§|$)`, 'i')
	if (!pattern.test(content)) return content
	return content.replace(pattern, `$1${body.trimEnd()}\n`)
}

export function validateCaveKitSpec(content: string): CaveKitSpecValidationResult {
	const parsed = parseCaveKitSpec(content)
	const reasons: string[] = []
	if (!parsed.sections.goal) reasons.push('missing §G GOAL')
	if (!parsed.sections.tasks) reasons.push('missing §T TASKS')
	if (!parsed.sections.invariants) reasons.push('missing §V INVARIANTS')
	if (!parsed.sections.bugs) reasons.push('missing §B BUGS')
	if (parsed.sections.tasks && normalizeHeader(parsed.taskHeader) !== 'id|status|task|cites') {
		reasons.push('invalid §T header')
	}
	if (parsed.sections.bugs && normalizeHeader(parsed.bugHeader) !== 'id|date|cause|fix') {
		reasons.push('invalid §B header')
	}
	for (const task of parsed.tasks) {
		if (!/^T\d+$/i.test(task.id)) reasons.push(`invalid task id ${task.id}`)
		if (!['.', '~', 'x'].includes(task.status)) reasons.push(`invalid task status ${task.status}`)
		if (!task.task.trim()) reasons.push(`empty task body ${task.id}`)
	}
	if (parsed.sections.bugs) {
		for (const row of parsed.bugRows) {
			if (row.length < 4) {
				const id = row[0] ?? 'unknown'
				reasons.push(`invalid bug row ${id}`)
			}
		}
	}
	return { valid: reasons.length === 0, reasons: uniqueStrings(reasons) }
}

export function renderCaveKitTasks(tasks: CaveKitTask[], header: string): string {
	const rows = tasks.map(task =>
		[task.id, normalizeTaskStatus(task.status), task.task.trim(), task.cites.join(',')].join('|'),
	)
	return [header.trim(), ...rows].join('\n')
}

export function renderTable(header: string, rows: string[][]): string {
	return [header.trim(), ...rows.map(row => row.map(cell => cell.trim()).join('|'))].join('\n')
}

export function normalizeTaskStatus(status: string): string {
	return status === 'x' || status === '~' ? status : '.'
}

export function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>()
	const ordered: string[] = []
	for (const value of values) {
		const trimmed = value.trim()
		if (!trimmed) continue
		const key = trimmed.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		ordered.push(trimmed)
	}
	return ordered
}

function collectSections(content: string): Partial<Record<CaveKitSection, string>> {
	const sections: Partial<Record<CaveKitSection, string>> = {}
	const markers = Array.from(content.matchAll(/^##\s+(§[GCIVTB])\s+[A-Z]+.*$/gm))

	for (const [index, match] of markers.entries()) {
		const marker = match[1]
		const section = markerToSection(marker)
		if (!section || match.index == null) continue
		const bodyStart = match.index + match[0].length + 1
		const bodyEnd = markers[index + 1]?.index ?? content.length
		sections[section] = content.slice(bodyStart, bodyEnd).trim()
	}

	return sections
}

function markerToSection(marker: string): CaveKitSection | null {
	if (marker === '§G') return 'goal'
	if (marker === '§C') return 'constraints'
	if (marker === '§I') return 'interfaces'
	if (marker === '§V') return 'invariants'
	if (marker === '§T') return 'tasks'
	if (marker === '§B') return 'bugs'
	return null
}

function firstMeaningfulLine(body: string): string {
	return (
		body
			.split('\n')
			.map(line => line.trim())
			.find(line => line.length > 0) ?? ''
	)
}

function parseListLines(body: string): string[] {
	return body
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.filter(line => !/^\|?[-: ]+\|[-|: ]+$/.test(line))
}

function parseTableSection(body: string, fallbackHeader: string): { header: string; rows: string[][] } {
	const lines = body
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.filter(line => !/^\|?[-: ]+\|[-|: ]+$/.test(line))

	if (lines.length === 0) {
		return { header: fallbackHeader, rows: [] }
	}

	const header = lines[0] ?? fallbackHeader
	const rows = lines
		.slice(1)
		.map(splitPipeRow)
		.filter(row => row.length > 0)
	return { header, rows }
}

function splitPipeRow(line: string): string[] {
	return line
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map(cell => cell.trim())
}

function splitCitations(raw: string): string[] {
	return uniqueStrings(
		raw
			.split(',')
			.map(value => value.trim())
			.filter(Boolean),
	)
}

function rankTasks(tasks: CaveKitTask[], prompt: CompiledPrompt): Array<{ task: CaveKitTask; score: number }> {
	const needles = uniqueStrings([
		...prompt.keywords,
		...prompt.goal
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter(token => token.length >= 4),
	])

	return tasks
		.map(task => {
			const haystack = `${task.id} ${task.task} ${task.cites.join(' ')}`.toLowerCase()
			const score = needles.reduce((sum, needle) => sum + (haystack.includes(needle.toLowerCase()) ? 1 : 0), 0)
			return { task, score }
		})
		.sort((a, b) => b.score - a.score || compareTaskIds(a.task.id, b.task.id))
}

function compareTaskIds(left: string, right: string): number {
	const leftNumber = Number.parseInt(left.replace(/^T/i, ''), 10)
	const rightNumber = Number.parseInt(right.replace(/^T/i, ''), 10)
	if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
	return left.localeCompare(right)
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeHeader(value: string): string {
	return value.replace(/\s+/g, '').trim().toLowerCase()
}
