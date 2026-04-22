import { readFileText, writeFileAtomic, fileExists } from '../shared/fs.js'
import type { ExecutionPlan, VerificationRecord } from './types.js'
import {
	parseCaveKitSpec,
	replaceCaveKitSection,
	renderCaveKitTasks,
	renderTable,
	uniqueStrings,
	validateCaveKitSpec,
	type CaveKitTask,
} from './spec.js'

export function applyVerificationToSpec(plan: ExecutionPlan | null, verification: VerificationRecord): boolean {
	if (!plan || plan.mode !== 'spec-driven' || !plan.specSource || !fileExists(plan.specSource)) return false

	const current = readFileText(plan.specSource)
	if (!current) return false

	let next = current
	next = updateTaskStatuses(next, plan, verification)
	if (verification.status === 'fail' || verification.status === 'flaky' || verification.status === 'unknown') {
		next = appendBugRow(next, plan, verification)
		next = appendInvariant(next, plan, verification)
	}

	if (next === current) return false
	const validation = validateCaveKitSpec(next)
	if (!validation.valid) return false
	writeFileAtomic(plan.specSource, ensureTrailingNewline(next))
	return true
}

function updateTaskStatuses(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const parsed = parseCaveKitSpec(spec)
	const taskIDs = new Set(inferAffectedTaskIds(plan))
	if (taskIDs.size === 0 || !parsed.sections.tasks || parsed.tasks.length === 0) return spec

	let changed = false
	const updatedTasks = parsed.tasks.map(task => {
		if (!taskIDs.has(task.id)) return task
		const nextStatus = determineTaskStatus(task.status, verification.status)
		if (nextStatus === task.status) return task
		changed = true
		return { ...task, status: nextStatus }
	})
	if (!changed) return spec

	return replaceCaveKitSection(spec, 'tasks', renderCaveKitTasks(updatedTasks, parsed.taskHeader))
}

function appendBugRow(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const parsed = parseCaveKitSpec(spec)
	if (!parsed.sections.bugs) return spec
	const taskIds = inferAffectedTaskIds(plan)
	const citations = collectPlanCitations(plan, taskIds)
	const subsystem = inferSubsystem(citations, plan.goal, verification.command)
	const fixReference = inferFixReference(plan, verification, taskIds, citations)
	const date = new Date(verification.timestamp).toISOString().slice(0, 10)
	const cause = truncateCell(`${verification.command} -> ${verification.status} [${subsystem}]`, 96)
	const fix = truncateCell(fixReference, 120)
	const nextId = `B${
		countRows(
			parsed.bugRows.map(row => row.join('|')),
			/^B\d+\|/,
		) + 1
	}`
	const row = [nextId, date, cause, fix]
	const fingerprint = normalizeBugFingerprint(row)
	const duplicate = parsed.bugRows.some(existing => normalizeBugFingerprint(existing) === fingerprint)
	if (duplicate) return spec
	const rows = [...parsed.bugRows, row]
	return replaceCaveKitSection(spec, 'bugs', renderTable(parsed.bugHeader, rows))
}

function appendInvariant(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const parsed = parseCaveKitSpec(spec)
	if (!parsed.sections.invariants) return spec
	const lines = parsed.invariants.slice()
	const invariant = inferInvariantLine(lines, plan, verification)
	if (!invariant) return spec
	if (lines.some(line => normalizeText(line) === normalizeText(invariant))) return spec
	const updated = [...lines, invariant]
	return replaceCaveKitSection(spec, 'invariants', updated.join('\n'))
}

function determineTaskStatus(current: string, verificationStatus: VerificationRecord['status']): string {
	if (verificationStatus === 'pass') return current === 'x' ? 'x' : 'x'
	if (current === 'x') return 'x'
	return '~'
}

function inferFixReference(
	plan: ExecutionPlan,
	verification: VerificationRecord,
	taskIds: string[],
	citations: string[],
): string {
	const taskRef = taskIds.length > 0 ? taskIds.join(',') : 'active-task'
	const citeRef = citations.length > 0 ? citations.join(',') : 'no-cites'
	if (verification.status === 'fail') return `${taskRef}; cites=${citeRef}; reproduce and fix failing path`
	if (verification.status === 'flaky') return `${taskRef}; cites=${citeRef}; stabilize flaky verification`
	return `${taskRef}; cites=${citeRef}; classify verifier output`
}

function inferInvariantLine(existing: string[], plan: ExecutionPlan, verification: VerificationRecord): string {
	const nextNumber = countRows(existing, /^V\d+:/i) + 1
	const taskIds = inferAffectedTaskIds(plan)
	const citations = collectPlanCitations(plan, taskIds)
	const taskRef = taskIds.length > 0 ? taskIds.join(',') : 'active task'
	const citeRef = citations[0] ? ` Preserve ${citations[0]}.` : ''
	if (verification.status === 'flaky') {
		return `V${nextNumber}: stabilize ${verification.command} before closing ${taskRef}.${citeRef}`
	}
	if (verification.status === 'unknown') {
		return `V${nextNumber}: classify ${verification.command} result before closing ${taskRef}.${citeRef}`
	}
	return `V${nextNumber}: verify ${verification.command} before closing ${taskRef}.${citeRef}`
}

function countRows(lines: string[], pattern: RegExp): number {
	return lines.filter(line => pattern.test(line)).length
}

function inferAffectedTaskIds(plan: ExecutionPlan): string[] {
	return uniqueStrings(plan.steps.map(step => step.id).filter(id => /^T\d+$/i.test(id)))
}

function collectPlanCitations(plan: ExecutionPlan, taskIds: string[]): string[] {
	const relevantSteps = taskIds.length > 0 ? plan.steps.filter(step => taskIds.includes(step.id)) : plan.steps
	return uniqueStrings(relevantSteps.flatMap(step => step.citations))
}

function inferSubsystem(citations: string[], goal: string, command: string): string {
	const interfaceRef = citations.find(citation => /^I[.:]/i.test(citation))
	if (interfaceRef) return interfaceRef.replace(/^I[.:]?/i, '').split(/[\s,]+/)[0] || 'interface'
	if (/test|check|lint|typecheck|build/i.test(command)) return 'verification'
	const words = goal
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter(word => word.length >= 4)
	return words[0] ?? 'runtime'
}

function normalizeBugFingerprint(row: string[]): string {
	return normalizeText(row.slice(2).join('|'))
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function truncateCell(value: string, max: number): string {
	const safe = value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
	return safe.length <= max ? safe : `${safe.slice(0, max - 3)}...`
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith('\n') ? value : `${value}\n`
}
