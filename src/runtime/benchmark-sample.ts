import { SessionRuntimeTracker } from './session-runtime.js'
import type { ExecutionPlan } from './types.js'

export interface BenchmarkSample {
	sessionID: string
	phase: string
	internalPhase: string
	goal: string
	mode: string
	taskCoverage: string
	currentTarget: string
	memoryProtocol: string
	memorySessionPointer: string
	elapsedMs: number
	updatedAt: string
	verification: {
		command: string
		status: string
		summary: string
		exitCode: number | null
		timestamp: number
	}
	telemetry: {
		l01Prompt: TelemetryLayer
		l02Tool: TelemetryLayer
		l03Output: TelemetryLayer
		l04Context: TelemetryLayer
	}
	total: string
}

interface TelemetryLayer {
	baselineChars: number
	compressedChars: number
	savedChars: number
	sampleCount: number
	lastBaselineChars: number
	lastCompressedChars: number
	lastSavedChars: number
}

export function createSampleBenchmarkSnapshot(): BenchmarkSample {
	const tracker = new SessionRuntimeTracker()
	const plan: ExecutionPlan = {
		mode: 'spec-driven',
		goal: 'Add auth refresh endpoint per SPEC.md and verify the flow.',
		summary: 'SPEC-backed plan with explicit verify.',
		steps: [
			{
				id: 'A1',
				kind: 'inspect',
				title: 'Inspect auth refresh flow',
				reason: '',
				citations: [],
				acceptance: [],
			},
			{
				id: 'T1',
				kind: 'edit',
				title: 'Add auth refresh endpoint',
				reason: '',
				citations: ['V1', 'I.api'],
				acceptance: [],
			},
			{ id: 'T2', kind: 'edit', title: 'Add auth refresh tests', reason: '', citations: ['V1'], acceptance: [] },
			{ id: 'T3', kind: 'edit', title: 'Update auth docs', reason: '', citations: ['I.docs'], acceptance: [] },
			{
				id: 'V1',
				kind: 'verify',
				title: 'Run bun test',
				reason: '',
				citations: [],
				acceptance: ['Run bun test'],
			},
		],
		sourceArtifacts: ['CaveKit Spec'],
		specSource: 'SPEC.md',
		memoryRefs: ['MCP Auth Recall'],
		validationCommands: ['bun test'],
	}
	tracker.setPhase('load-context')
	tracker.setPlan(plan)
	tracker.setCurrentTarget('src/auth/refresh.ts')
	tracker.setMemoryProtocol('cavemem mcp primary; local bridge fallback')
	tracker.setMemorySessionPointer('cavemem://session/sample-auth-refresh')
	tracker.notePromptCompression(900, 270)
	tracker.notePromptCompression(300, 90)
	tracker.noteToolCompression({
		mode: 'rewritten',
		baselineChars: 120,
		compressedChars: 60,
		reason: 'RTK rewrite applied',
	})
	tracker.noteToolCompression({
		mode: 'rewritten',
		baselineChars: 95,
		compressedChars: 36,
		reason: 'RTK rewrite applied',
	})
	tracker.noteToolCompression({
		mode: 'rewritten',
		baselineChars: 110,
		compressedChars: 48,
		reason: 'RTK rewrite applied',
	})
	tracker.noteToolCompression({
		mode: 'rewritten',
		baselineChars: 95,
		compressedChars: 36,
		reason: 'RTK rewrite applied',
	})
	tracker.noteOutputCompression(740, 298)
	tracker.noteOutputCompression(240, 92)
	tracker.noteOutputCompression(0, 0)
	tracker.noteContextCompression(18_400, 3_900)
	tracker.noteVerification({
		command: 'bun test',
		status: 'pass',
		summary: 'bun test [pass exit=0] 41 pass 0 fail',
		exitCode: 0,
		timestamp: 1776822300000,
	})
	const snapshot = tracker.snapshot()
	return {
		sessionID: 'sample-auth-refresh',
		phase: 'done',
		internalPhase: snapshot.phase,
		goal: snapshot.plan?.goal ?? '',
		mode: snapshot.plan?.mode ?? 'unknown',
		taskCoverage: '5 steps (1 inspect, 3 edit, 1 verify)',
		currentTarget: snapshot.currentTarget,
		memoryProtocol: snapshot.memoryProtocol,
		memorySessionPointer: snapshot.memorySessionPointer,
		elapsedMs: 47_000,
		updatedAt: '2026-04-22T01:45:00.000Z',
		verification: snapshot.verificationRecords.at(-1)!,
		telemetry: snapshot.telemetry,
		total: formatTotal(snapshot.telemetry),
	}
}

function layer(
	baselineChars: number,
	compressedChars: number,
	sampleCount: number,
	lastBaselineChars: number,
	lastCompressedChars: number,
): TelemetryLayer {
	return {
		baselineChars,
		compressedChars,
		savedChars: baselineChars - compressedChars,
		sampleCount,
		lastBaselineChars,
		lastCompressedChars,
		lastSavedChars: lastBaselineChars - lastCompressedChars,
	}
}

function formatTotal(telemetry: BenchmarkSample['telemetry']): string {
	const layers = [telemetry.l01Prompt, telemetry.l02Tool, telemetry.l03Output, telemetry.l04Context]
	const baseline = layers.reduce((sum, layer) => sum + layer.baselineChars, 0)
	const compressed = layers.reduce((sum, layer) => sum + layer.compressedChars, 0)
	const saved = layers.reduce((sum, layer) => sum + layer.savedChars, 0)
	const samples = layers.reduce((sum, layer) => sum + layer.sampleCount, 0)
	const percent = baseline > 0 ? ((saved / baseline) * 100).toFixed(1) : '0.0'
	return `baseline ${baseline} -> ${compressed} chars (~${Math.ceil(baseline / 4)} -> ~${Math.ceil(compressed / 4)} tok), saved ${saved} (${percent}%), samples ${samples}`
}
