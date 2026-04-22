import type { ExtraContext } from '../context/instructions.js'
import type { MemoryHeader } from '../memory/scan.js'
import type { TaskFocusState } from '../context/compaction.js'
import type { CompiledPrompt, ExecutionPlan, ExecutionStep } from './types.js'
import {
	parseCaveKitSpec,
	selectCaveKitTasks,
	extractSpecValidationCommands,
	uniqueStrings,
	type CaveKitTask,
	type ParsedCaveKitSpec,
} from './spec.js'

export function buildExecutionPlan(input: {
	compiledPrompt: CompiledPrompt
	rootContext: ExtraContext[]
	memories: MemoryHeader[]
	taskFocus: TaskFocusState
	discoveryHints?: string[]
}): ExecutionPlan {
	const spec = input.rootContext.find(ctx => ctx.label === 'CaveKit Spec')
	const parsedSpec = spec ? parseCaveKitSpec(spec.content) : null
	const tasks = parsedSpec?.tasks ?? []
	const mode = tasks.length > 0 ? 'spec-driven' : 'ad-hoc'
	const validationCommands = inferValidationCommands(input.compiledPrompt, input.memories, parsedSpec)
	const discoveryHints = input.discoveryHints ?? []
	const sourceArtifacts = uniqueStrings([
		...input.rootContext.map(ctx => ctx.label),
		...discoveryHints.slice(0, 3).map(hint => `GraphLite Hint: ${hint}`),
	])
	const memoryRefs = input.memories.map(memory => memory.title)

	if (mode === 'spec-driven') {
		const specDetails = parsedSpec as ParsedCaveKitSpec
		const selectedTasks = selectCaveKitTasks(tasks, input.compiledPrompt)
		const plannedSteps: ExecutionStep[] =
			selectedTasks.length > 0
				? selectedTasks.map((task, index) => ({
						id: task.id || `S${index + 1}`,
						kind: index === selectedTasks.length - 1 ? 'verify' : 'edit',
						title: task.task,
						reason:
							task.status === '~'
								? 'Resume active CaveKit task.'
								: 'Advance next CaveKit task from SPEC.md.',
						citations: uniqueStrings([...task.cites, ...resolveSpecReferences(task.cites, parsedSpec)]),
						acceptance: buildAcceptance(task, validationCommands, parsedSpec),
					}))
				: [
						{
							id: 'CHK',
							kind: 'verify',
							title: `Verify SPEC drift with ${formatValidationList(validationCommands)}`,
							reason: 'No unfinished CaveKit tasks remain; check drift and verification status.',
							citations: uniqueStrings([
								...specDetails.constraints.slice(0, 2),
								...specDetails.interfaces.slice(0, 2),
								...specDetails.invariants.slice(0, 2),
							]),
							acceptance: validationCommands.map(command => `Run ${command}`),
						},
					]
		return {
			mode,
			goal: specDetails.goal || input.compiledPrompt.goal,
			summary: buildSpecSummary(selectedTasks, validationCommands, specDetails, discoveryHints),
			steps: plannedSteps,
			sourceArtifacts,
			specSource: spec?.source ?? '',
			memoryRefs,
			validationCommands,
		}
	}

	const adHocSteps = buildAdHocSteps(
		input.compiledPrompt,
		input.taskFocus,
		validationCommands,
		input.discoveryHints ?? [],
	)
	return {
		mode,
		goal: input.compiledPrompt.goal,
		summary: `Ad-hoc runtime plan. Inspect likely files, apply smallest correct edit, then verify with ${formatValidationList(validationCommands)}.`,
		steps: adHocSteps,
		sourceArtifacts,
		specSource: '',
		memoryRefs,
		validationCommands,
	}
}

export function renderExecutionPlan(plan: ExecutionPlan, phase: string): string {
	const lines: string[] = [
		`# Hybrid Runtime Plan (${plan.mode})`,
		'',
		`Phase: ${phase}`,
		`Goal: ${plan.goal}`,
		`Summary: ${plan.summary}`,
	]

	if (plan.sourceArtifacts.length > 0) {
		lines.push(`Sources: ${plan.sourceArtifacts.join(', ')}`)
	}

	if (plan.memoryRefs.length > 0) {
		lines.push(`Memory: ${plan.memoryRefs.join(', ')}`)
	}

	if (plan.validationCommands.length > 0) {
		lines.push(`Verify: ${plan.validationCommands.join(' ; ')}`)
	}

	if (plan.steps.length > 0) {
		lines.push('', '## Steps')
		for (const step of plan.steps.slice(0, 5)) {
			lines.push(`- ${step.id} [${step.kind}] ${step.title}`)
			if (step.citations.length > 0) lines.push(`  cites: ${step.citations.join(', ')}`)
			if (step.acceptance.length > 0) lines.push(`  accept: ${step.acceptance.join(' | ')}`)
		}
	}

	return lines.join('\n')
}

export function summarizeExecutionPlan(plan: ExecutionPlan): string {
	const steps = plan.steps
		.slice(0, 3)
		.map(step => `${step.id}:${step.title}`)
		.join(' | ')
	return `${plan.mode}; ${plan.goal}; ${steps}`.trim()
}

function buildAcceptance(task: CaveKitTask, validationCommands: string[], spec: ParsedCaveKitSpec | null): string[] {
	const acceptance = ['Edit complete and behavior aligned with cited spec references.']
	if (task.cites.length > 0) acceptance.push(`Respect ${task.cites.join(', ')}.`)
	const references = spec ? resolveSpecReferences(task.cites, spec) : []
	for (const reference of references.slice(0, 3)) {
		acceptance.push(`Preserve ${reference}.`)
	}
	if (validationCommands.length > 0) acceptance.push(`Run ${formatValidationList(validationCommands)}.`)
	return acceptance
}

function buildSpecSummary(
	tasks: CaveKitTask[],
	validationCommands: string[],
	spec: ParsedCaveKitSpec | null,
	discoveryHints: string[],
): string {
	const taskSummary = tasks.map(task => `${task.id}:${task.task}`).join(' | ')
	const guardrails = spec
		? uniqueStrings([...spec.constraints.slice(0, 1), ...spec.invariants.slice(0, 2)]).join(' | ')
		: ''
	const hints = discoveryHints.length > 0 ? ` Likely files: ${discoveryHints.slice(0, 3).join(', ')}.` : ''
	const verification =
		validationCommands.length > 0 ? ` Verify with ${formatValidationList(validationCommands)}.` : ''
	const taskClause = taskSummary ? `Advance ${taskSummary}.` : 'No open CaveKit tasks. Validate current state.'
	const guardrailClause = guardrails ? ` Preserve ${guardrails}.` : ''
	return `SPEC-backed plan. ${taskClause}${guardrailClause}${hints}${verification}`.trim()
}

function buildAdHocSteps(
	compiledPrompt: CompiledPrompt,
	taskFocus: TaskFocusState,
	validationCommands: string[],
	discoveryHints: string[],
): ExecutionStep[] {
	const inspectTarget = taskFocus.activeArtifacts[0] || discoveryHints[0] || ''
	const inspectTitle = inspectTarget
		? `Inspect related files starting from ${inspectTarget}`
		: 'Inspect relevant files and current behavior'
	return [
		{
			id: 'A1',
			kind: 'inspect',
			title: inspectTitle,
			reason: 'Need file-level context before editing.',
			citations: [],
			acceptance: ['Relevant code path identified.'],
		},
		{
			id: 'A2',
			kind: 'edit',
			title: compiledPrompt.goal,
			reason: 'Implement smallest correct change for current request.',
			citations: compiledPrompt.constraints.map(constraint => constraint.text),
			acceptance: ['Requested behavior implemented.', 'Constraints preserved.'],
		},
		{
			id: 'A3',
			kind: 'verify',
			title: `Verify with ${formatValidationList(validationCommands)}`,
			reason: 'Need concrete signal before marking work complete.',
			citations: [],
			acceptance: validationCommands.map(command => `Run ${command}`),
		},
	]
}

function inferValidationCommandsFallback(compiledPrompt: CompiledPrompt, memories: MemoryHeader[]): string[] {
	const text = `${compiledPrompt.normalized} ${memories.map(memory => memory.title).join(' ')}`.toLowerCase()
	if (/\btest\b|spec\b|jest\b|vitest\b/.test(text)) return ['bun test']
	if (/\blint\b/.test(text)) return ['bun run lint']
	if (/\btypecheck\b|typescript\b/.test(text)) return ['bun run typecheck']
	if (/\bbuild\b/.test(text)) return ['bun run build']
	return ['bun test', 'bun run typecheck']
}

function inferValidationCommands(
	compiledPrompt: CompiledPrompt,
	memories: MemoryHeader[],
	spec: ParsedCaveKitSpec | null,
): string[] {
	const commands = uniqueStrings([
		...(spec ? extractSpecValidationCommands(spec) : []),
		...inferValidationCommandsFallback(compiledPrompt, memories),
	])
	return commands.slice(0, 3)
}

function resolveSpecReferences(citations: string[], spec: ParsedCaveKitSpec | null): string[] {
	if (!spec) return []
	const references: string[] = []
	for (const citation of citations) {
		if (/^V\d+$/i.test(citation)) {
			const match = spec.invariants.find(line => line.toLowerCase().startsWith(`${citation.toLowerCase()}:`))
			if (match) references.push(match)
			continue
		}
		if (/^I[.:]/i.test(citation)) {
			const match = spec.interfaces.find(line => line.toLowerCase().startsWith(citation.toLowerCase()))
			if (match) references.push(match)
		}
	}
	return uniqueStrings(references)
}

function formatValidationList(commands: string[]): string {
	return commands.join(' + ')
}
