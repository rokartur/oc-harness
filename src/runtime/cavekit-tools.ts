import { join } from 'node:path'
import { compileUserPrompt } from './prompt-compiler.js'
import {
	parseCaveKitSpec,
	extractSpecValidationCommands,
	renderCaveKitTasks,
	renderTable,
	replaceCaveKitSection,
	uniqueStrings,
	type CaveKitTask,
	type ParsedCaveKitSpec,
} from './spec.js'
import { fileExists, readFileText, withFileLock, writeFileAtomic } from '../shared/fs.js'

const SPEC_FILE = 'SPEC.md'
const SPEC_LOCK = '.openharness/locks/spec.lock'
const TASK_HEADER = 'id|status|task|cites'
const BUG_HEADER = 'id|date|cause|fix'

export interface CaveKitSpecMutationInput {
	scope?: string
	goal?: string
	constraints?: string[]
	interfaces?: string[]
	invariants?: string[]
	tasks?: string[]
	bugs?: string[]
}

export interface CaveKitSpecMutationResult {
	path: string
	created: boolean
	changed: boolean
	goal: string
	taskCoverage: string
	validationCommands: string[]
	content: string
}

export interface CaveKitBuildResult {
	path: string
	goal: string
	selectedTasks: CaveKitTask[]
	validationCommands: string[]
	taskCoverage: string
	changed: boolean
	content: string
}

export interface CaveKitCheckFinding {
	severity: 'fail' | 'warn' | 'info'
	reference: string
	message: string
}

export interface CaveKitCheckResult {
	path: string
	goal: string
	taskCoverage: string
	validationCommands: string[]
	findings: CaveKitCheckFinding[]
	content: string
}

export function resolveCaveKitSpecPath(cwd: string): string {
	return join(cwd, SPEC_FILE)
}

export function upsertCaveKitSpec(cwd: string, input: CaveKitSpecMutationInput = {}): CaveKitSpecMutationResult {
	const specPath = resolveCaveKitSpecPath(cwd)
	const compiled = compileUserPrompt(input.scope ?? input.goal ?? '')
	return withFileLock(join(cwd, SPEC_LOCK), () => {
		const current = readFileText(specPath)
		const parsed = current ? parseCaveKitSpec(current) : createEmptyParsedSpec()
		const goal = input.goal?.trim() || parsed.goal || compiled.goal || 'Define the current project goal.'
		const constraints = uniqueStrings([
			...parsed.constraints,
			...(input.constraints ?? compiled.constraints.map(constraint => constraint.text)),
		])
		const interfaces = mergeInterfaces(
			parsed.interfaces,
			input.interfaces ?? inferInterfaces(input.scope ?? input.goal ?? ''),
		)
		const invariants = mergeInvariants(
			parsed.invariants,
			input.invariants ?? inferInvariants(input.scope ?? input.goal ?? '', goal),
		)
		const tasks = mergeTasks(
			parsed.tasks,
			input.tasks ?? inferTasks(input.scope ?? input.goal ?? '', goal),
			interfaces,
			invariants,
		)
		const bugRows = mergeBugRows(parsed.bugRows, input.bugs ?? [])
		const next = renderFullSpec({
			goal,
			constraints,
			interfaces,
			invariants,
			tasks,
			bugRows,
		})
		const changed = next !== (current ?? '')
		if (changed) writeFileAtomic(specPath, ensureTrailingNewline(next))
		const finalParsed = parseCaveKitSpec(next)
		return {
			path: specPath,
			created: !current,
			changed,
			goal,
			taskCoverage: formatTaskCoverage(finalParsed),
			validationCommands: extractSpecValidationCommands(finalParsed),
			content: next,
		}
	})
}

export function buildCaveKitPlan(
	cwd: string,
	input: { selector?: string; focus?: string; limit?: number; markActive?: boolean } = {},
): CaveKitBuildResult {
	const specPath = resolveCaveKitSpecPath(cwd)
	const current = readFileText(specPath)
	if (!current) {
		throw new Error('SPEC.md not found. Run ck:spec first.')
	}

	return withFileLock(join(cwd, SPEC_LOCK), () => {
		const parsed = parseCaveKitSpec(current)
		const selectedTasks = selectTasks(parsed, input.selector, input.focus, input.limit ?? 3)
		const nextTasks = parsed.tasks.map(task => {
			if (!input.markActive) return task
			if (!selectedTasks.some(selected => selected.id === task.id)) return task
			if (task.status !== '.') return task
			return { ...task, status: '~' }
		})
		const nextContent =
			input.markActive && nextTasks.some((task, index) => task.status !== parsed.tasks[index]?.status)
				? replaceCaveKitSection(
						current,
						'tasks',
						renderCaveKitTasks(nextTasks, parsed.taskHeader || TASK_HEADER),
					)
				: current
		if (nextContent !== current) writeFileAtomic(specPath, ensureTrailingNewline(nextContent))
		const finalParsed = parseCaveKitSpec(nextContent)
		return {
			path: specPath,
			goal: finalParsed.goal,
			selectedTasks: finalParsed.tasks.filter(task => selectedTasks.some(selected => selected.id === task.id)),
			validationCommands: extractSpecValidationCommands(finalParsed),
			taskCoverage: formatTaskCoverage(finalParsed),
			changed: nextContent !== current,
			content: nextContent,
		}
	})
}

export function checkCaveKitDrift(cwd: string, focus?: string): CaveKitCheckResult {
	const specPath = resolveCaveKitSpecPath(cwd)
	const current = readFileText(specPath)
	if (!current) {
		throw new Error('SPEC.md not found. Run ck:spec first.')
	}
	const parsed = parseCaveKitSpec(current)
	const findings = collectCheckFindings(cwd, parsed, focus)
	return {
		path: specPath,
		goal: parsed.goal,
		taskCoverage: formatTaskCoverage(parsed),
		validationCommands: extractSpecValidationCommands(parsed),
		findings,
		content: current,
	}
}

export function formatTaskCoverage(parsed: ParsedCaveKitSpec): string {
	const total = parsed.tasks.length
	const done = parsed.tasks.filter(task => task.status === 'x').length
	const active = parsed.tasks.filter(task => task.status === '~').length
	const pending = parsed.tasks.filter(task => task.status === '.').length
	return `${done}/${total} done, ${active} active, ${pending} pending`
}

function createEmptyParsedSpec(): ParsedCaveKitSpec {
	return {
		goal: '',
		constraints: [],
		interfaces: [],
		invariants: [],
		tasks: [],
		taskHeader: TASK_HEADER,
		bugHeader: BUG_HEADER,
		bugRows: [],
		sections: {},
	}
}

function mergeInterfaces(existing: string[], next: string[]): string[] {
	const merged = [...existing]
	for (const entry of next) {
		const normalized = normalizeInterfaceLine(entry)
		if (!normalized) continue
		if (merged.some(line => line.toLowerCase() === normalized.toLowerCase())) continue
		merged.push(normalized)
	}
	return merged
}

function mergeInvariants(existing: string[], next: string[]): string[] {
	const merged = existing.slice()
	let nextIndex = countInvariantRows(existing) + 1
	for (const entry of next) {
		const normalized = normalizeInvariantLine(entry, nextIndex)
		if (!normalized) continue
		const comparable = stripInvariantPrefix(normalized)
		if (merged.some(line => stripInvariantPrefix(line).toLowerCase() === comparable.toLowerCase())) continue
		merged.push(normalized)
		nextIndex++
	}
	return merged
}

function mergeTasks(
	existing: CaveKitTask[],
	next: string[],
	interfaces: string[],
	invariants: string[],
): CaveKitTask[] {
	const merged = existing.slice()
	let nextIndex = countTaskRows(existing) + 1
	const defaultCites = uniqueStrings([
		firstReference(invariants, /^V\d+:/i, value => value.match(/^(V\d+):/i)?.[1] ?? ''),
		firstReference(interfaces, /^I[.:]/i, value => value.match(/^(I[^:]+):/i)?.[1] ?? ''),
	])
	for (const entry of next) {
		const taskBody = entry.trim()
		if (!taskBody) continue
		if (merged.some(task => task.task.toLowerCase() === taskBody.toLowerCase())) continue
		merged.push({
			id: `T${nextIndex}`,
			status: '.',
			task: taskBody,
			cites: defaultCites,
			line: '',
		})
		nextIndex++
	}
	return merged
}

function mergeBugRows(existing: string[][], bugs: string[]): string[][] {
	const rows = existing.slice()
	let nextIndex = existing.length + 1
	for (const bug of bugs) {
		const message = bug.trim()
		if (!message) continue
		const fingerprint = message.toLowerCase()
		if (rows.some(row => row.join('|').toLowerCase().includes(fingerprint))) continue
		rows.push([`B${nextIndex}`, new Date().toISOString().slice(0, 10), message, 'investigate and backprop'])
		nextIndex++
	}
	return rows
}

function inferInterfaces(scope: string): string[] {
	const entries = uniqueStrings([
		...Array.from(scope.matchAll(/`([^`]+)`/g), match => match[1] ?? ''),
		...Array.from(
			scope.matchAll(/(?:\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/)+)[A-Za-z0-9_.\-/]+(?:\.[A-Za-z0-9_.-]+)?/g),
			match => match[0] ?? '',
		),
		...Array.from(
			scope.matchAll(/\/(?:caveman(?::compress)?|cavemem|ck:spec|ck:build|ck:check)\b/g),
			match => match[0] ?? '',
		),
	])
	return entries.slice(0, 6)
}

function inferInvariants(scope: string, goal: string): string[] {
	const compiled = compileUserPrompt(scope || goal)
	const invariants = compiled.constraints
		.filter(constraint => constraint.kind === 'must' || constraint.kind === 'avoid' || constraint.kind === 'prefer')
		.map(constraint => constraint.text)
	return invariants.length > 0
		? invariants
		: [`Keep ${goal.toLowerCase() || 'the requested behavior'} aligned with spec constraints.`]
}

function inferTasks(scope: string, goal: string): string[] {
	const source = scope.trim() || goal.trim()
	if (!source) return []
	const parts = source
		.split(/\b(?:and then|then| and )\b/i)
		.map(part => part.trim())
		.filter(part => part.length >= 8)
	return uniqueStrings(parts.length > 0 ? parts : [goal])
}

function renderFullSpec(input: {
	goal: string
	constraints: string[]
	interfaces: string[]
	invariants: string[]
	tasks: CaveKitTask[]
	bugRows: string[][]
}): string {
	return [
		'# SPEC',
		'',
		'## §G GOAL',
		input.goal.trim(),
		'',
		'## §C CONSTRAINTS',
		...(input.constraints.length > 0
			? input.constraints.map(item => `- ${stripListPrefix(item)}`)
			: ['- Keep smallest correct diff.']),
		'',
		'## §I INTERFACES',
		...(input.interfaces.length > 0 ? input.interfaces : ['I.runtime: preserve flagship runtime flow.']),
		'',
		'## §V INVARIANTS',
		...(input.invariants.length > 0 ? input.invariants : ['V1: verify behavior before closing tasks.']),
		'',
		'## §T TASKS',
		renderCaveKitTasks(input.tasks, TASK_HEADER),
		'',
		'## §B BUGS',
		renderTable(BUG_HEADER, input.bugRows),
	].join('\n')
}

function selectTasks(parsed: ParsedCaveKitSpec, selector?: string, focus?: string, limit: number = 3): CaveKitTask[] {
	const normalizedSelector = selector?.trim() ?? ''
	let tasks = parsed.tasks.slice()
	if (normalizedSelector === '.' || normalizedSelector === '~' || normalizedSelector === 'x') {
		tasks = tasks.filter(task => task.status === normalizedSelector)
	} else if (/^T\d+(?:\s*,\s*T\d+)*$/i.test(normalizedSelector)) {
		const ids = normalizedSelector.split(',').map(value => value.trim().toLowerCase())
		tasks = tasks.filter(task => ids.includes(task.id.toLowerCase()))
	}

	if (focus?.trim()) {
		const compiled = compileUserPrompt(focus)
		const needles = uniqueStrings([compiled.goal, ...compiled.keywords]).map(value => value.toLowerCase())
		tasks = tasks
			.map(task => ({
				task,
				score: needles.reduce((sum, needle) => {
					if (!needle) return sum
					const haystack = `${task.id} ${task.task} ${task.cites.join(' ')}`.toLowerCase()
					return sum + (haystack.includes(needle) ? 1 : 0)
				}, 0),
			}))
			.sort((left, right) => right.score - left.score || compareTaskNumbers(left.task.id, right.task.id))
			.map(entry => entry.task)
	}

	const active = tasks.filter(task => task.status === '~')
	if (active.length > 0 && normalizedSelector !== 'x') return active.slice(0, limit)
	const open = tasks.filter(task => task.status !== 'x')
	return (open.length > 0 ? open : tasks).slice(0, limit)
}

function collectCheckFindings(cwd: string, parsed: ParsedCaveKitSpec, focus?: string): CaveKitCheckFinding[] {
	const findings: CaveKitCheckFinding[] = []
	if (!parsed.goal) findings.push({ severity: 'fail', reference: '§G', message: 'missing goal text' })
	if (parsed.constraints.length === 0)
		findings.push({ severity: 'warn', reference: '§C', message: 'no constraints listed' })
	if (parsed.interfaces.length === 0)
		findings.push({ severity: 'warn', reference: '§I', message: 'no interfaces listed' })
	if (parsed.invariants.length === 0)
		findings.push({ severity: 'fail', reference: '§V', message: 'no invariants listed' })
	if (parsed.tasks.length === 0) findings.push({ severity: 'fail', reference: '§T', message: 'no tasks listed' })

	for (const line of parsed.interfaces) {
		for (const path of extractPathReferences(line)) {
			if (!fileExists(join(cwd, path))) {
				findings.push({ severity: 'warn', reference: '§I', message: `missing referenced path '${path}'` })
			}
		}
	}

	const invariantIds = new Set(
		parsed.invariants.map(line => line.match(/^(V\d+):/i)?.[1]?.toUpperCase() ?? '').filter(Boolean),
	)
	const interfaceIds = new Set(
		parsed.interfaces.map(line => line.match(/^(I[^:]+):/i)?.[1]?.toUpperCase() ?? '').filter(Boolean),
	)
	for (const task of parsed.tasks) {
		for (const cite of task.cites) {
			const upper = cite.toUpperCase()
			if (upper.startsWith('V') && !invariantIds.has(upper)) {
				findings.push({ severity: 'fail', reference: task.id, message: `missing cited invariant '${cite}'` })
			}
			if (upper.startsWith('I') && !interfaceIds.has(upper)) {
				findings.push({ severity: 'fail', reference: task.id, message: `missing cited interface '${cite}'` })
			}
		}
	}

	const validationCommands = extractSpecValidationCommands(parsed)
	if (validationCommands.length === 0) {
		findings.push({ severity: 'warn', reference: '§T', message: 'no validation command inferred from spec' })
	}
	if (parsed.tasks.some(task => task.status === '~')) {
		findings.push({ severity: 'info', reference: '§T', message: 'active tasks in progress' })
	}

	const filtered = applyFocusFilter(findings, focus)
	return filtered.length > 0
		? filtered
		: [{ severity: 'info', reference: 'SPEC', message: 'no obvious drift detected' }]
}

function normalizeInterfaceLine(input: string): string {
	const text = input.trim()
	if (!text) return ''
	if (/^I[^:]+:/i.test(text)) return text
	const slug = makeSlug(text)
	return slug ? `I.${slug}: ${text}` : ''
}

function normalizeInvariantLine(input: string, index: number): string {
	const text = stripListPrefix(input.trim())
	if (!text) return ''
	if (/^V\d+:/i.test(text)) return text
	return `V${index}: ${text}`
}

function stripInvariantPrefix(value: string): string {
	return value.replace(/^V\d+:\s*/i, '').trim()
}

function stripListPrefix(value: string): string {
	return value.replace(/^[-*+]\s+/, '').trim()
}

function countInvariantRows(lines: string[]): number {
	return lines.filter(line => /^V\d+:/i.test(line)).length
}

function countTaskRows(tasks: CaveKitTask[]): number {
	return tasks.filter(task => /^T\d+$/i.test(task.id)).length
}

function firstReference(lines: string[], pattern: RegExp, pick: (value: string) => string): string {
	const match = lines.find(line => pattern.test(line))
	return match ? pick(match) : ''
}

function compareTaskNumbers(left: string, right: string): number {
	const leftNumber = Number.parseInt(left.replace(/^T/i, ''), 10)
	const rightNumber = Number.parseInt(right.replace(/^T/i, ''), 10)
	if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
	return left.localeCompare(right)
}

function makeSlug(input: string): string {
	const pathMatch = extractPathReferences(input)[0]
	if (pathMatch) {
		return pathMatch
			.split('/')
			.pop()!
			.replace(/\.[A-Za-z0-9_.-]+$/, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase()
	}
	const commandMatch = input.match(/\/(?:caveman(?::compress)?|cavemem|ck:spec|ck:build|ck:check)/i)?.[0]
	if (commandMatch)
		return commandMatch
			.replace(/^\//, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.toLowerCase()
	const keyword = input
		.toLowerCase()
		.match(/[a-z0-9_]+/g)
		?.find(token => token.length >= 3)
	return keyword ?? ''
}

function extractPathReferences(input: string): string[] {
	return uniqueStrings(
		Array.from(
			input.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g),
			match => match[0] ?? '',
		),
	)
}

function applyFocusFilter(findings: CaveKitCheckFinding[], focus?: string): CaveKitCheckFinding[] {
	if (!focus?.trim()) return findings
	const tokens = uniqueStrings(
		(focus.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []).filter(token => token.length >= 2),
	)
	const filtered = findings.filter(finding => {
		const haystack = `${finding.reference} ${finding.message}`.toLowerCase()
		return tokens.some(token => haystack.includes(token))
	})
	return filtered.length > 0 ? filtered : findings
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith('\n') ? value : `${value}\n`
}
