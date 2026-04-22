export type CavemanMode = 'lite' | 'full' | 'ultra'

export interface CavemanDirective {
	enabled?: boolean
	mode?: CavemanMode
}

const PROTECTED_SEGMENT =
	/```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|(?:\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/)+)[A-Za-z0-9_.\-/]+(?:\.[A-Za-z0-9_.-]+)?/g
const SAFE_FILLER = /\b(?:please|just|really|basically|actually|simply|quite|very|kind of|sort of)\b/gi
const SAFE_OPENERS = /\b(?:sure|certainly|of course|gladly|absolutely)\b[!,.\s]*/gi
const SAFE_HELPER_PHRASES =
	/\b(?:i can help with that|i can help|let me take a look|let me help|i'd be happy to help(?: with that)?)\b[!,.\s]*/gi
const SAFE_PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\bi think\b/gi, 'think'],
	[/\bi believe\b/gi, 'believe'],
	[/\bit seems\b/gi, 'seems'],
	[/\bit looks like\b/gi, 'looks like'],
	[/\bmost likely\b/gi, 'likely'],
	[/\bprobably\b/gi, 'likely'],
	[/\bthere (?:is|are)\b/gi, ''],
	[/\bin order to\b/gi, 'to'],
	[/\bfor example\b/gi, 'e.g.'],
	[/\bfor instance\b/gi, 'e.g.'],
	[/\byou need to\b/gi, 'need to'],
	[/\byou can\b/gi, 'can'],
	[/\bit is\b/gi, 'is'],
	[/\bit's\b/gi, 'is'],
]

const MODE_PROMPTS: Record<CavemanMode, string> = {
	lite: [
		'Respond terse like smart caveman. All technical substance stay. Only fluff die.',
		'Active every response until user says stop caveman or normal mode.',
		'Drop filler, pleasantries, and hedging. Keep grammar mostly intact.',
		'Pattern: [thing] [action] [reason]. [next step].',
		'Code, commands, paths, commit text, PR text, and exact error strings stay normal and exact.',
		'If warning, destructive action, or ambiguity needs clarity, be clear first then resume caveman.',
	].join(' '),
	full: [
		'Respond terse like smart caveman. All technical substance stay. Only fluff die.',
		'Active every response until user says stop caveman or normal mode.',
		'Drop articles, filler, pleasantries, and hedging. Fragments OK. Short synonyms.',
		'Pattern: [thing] [action] [reason]. [next step].',
		'Not: Sure, I would be happy to help. Yes: Bug in auth middleware. Fix below.',
		'Code, commands, paths, commit text, PR text, and exact error strings stay normal and exact.',
		'If warning, destructive action, or ambiguity needs clarity, be clear first then resume caveman.',
	].join(' '),
	ultra: [
		'Maximum caveman compression. Technical substance exact.',
		'Active every response until user says stop caveman or normal mode.',
		'Fragments preferred. Drop almost all filler and articles. Prefer shortest exact wording.',
		'Pattern: [thing] [action] [reason]. [next step].',
		'Code, commands, paths, commit text, PR text, and exact error strings stay normal and exact.',
		'If warning, destructive action, or ambiguity needs clarity, be clear first then resume caveman.',
	].join(' '),
}

export function buildCavemanSystemPrompt(mode: CavemanMode): string {
	return [
		`# Caveman Mode (${mode})`,
		'',
		MODE_PROMPTS[mode],
		'',
		'Intensity levels: lite = tight full sentences. full = default caveman. ultra = maximum compression.',
		'Compatibility aliases: wenyan-lite = lite, wenyan = full, wenyan-ultra = ultra.',
		'Switch with /caveman lite, /caveman full, /caveman ultra, /caveman wenyan-lite, /caveman wenyan, or /caveman wenyan-ultra. Disable with stop caveman or normal mode.',
	].join('\n')
}

export function detectCavemanDirective(input: string): CavemanDirective | null {
	const text = input.trim().toLowerCase()
	if (!text) return null
	const requestedMode = detectRequestedMode(text)

	if (text === '/caveman' || text === '/caveman full') {
		return { enabled: true, mode: 'full' }
	}
	if (text === '/caveman lite') {
		return { enabled: true, mode: 'lite' }
	}
	if (text === '/caveman wenyan-lite') {
		return { enabled: true, mode: 'lite' }
	}
	if (text === '/caveman ultra') {
		return { enabled: true, mode: 'ultra' }
	}
	if (text === '/caveman wenyan') {
		return { enabled: true, mode: 'full' }
	}
	if (text === '/caveman wenyan-ultra') {
		return { enabled: true, mode: 'ultra' }
	}

	if (
		/\b(stop|disable|deactivate|turn off)\b.*\bcaveman\b/.test(text) ||
		/\bcaveman\b.*\b(stop|disable|deactivate|turn off)\b/.test(text) ||
		/\bnormal mode\b/.test(text)
	) {
		return { enabled: false }
	}

	if (
		/\b(talk like|use|enable|activate|start)\b.*\bcaveman\b/.test(text) ||
		/\bcaveman\b.*\b(mode|on|please|again)\b/.test(text) ||
		/\bless tokens please\b/.test(text)
	) {
		return { enabled: true, ...(requestedMode ? { mode: requestedMode } : {}) }
	}

	return null
}

function detectRequestedMode(text: string): CavemanMode | undefined {
	if (/\bwenyan-ultra\b/.test(text)) return 'ultra'
	if (/\bwenyan-lite\b/.test(text)) return 'lite'
	if (/\bwenyan\b/.test(text)) return 'full'
	if (/\bultra\b/.test(text)) return 'ultra'
	if (/\blite\b/.test(text)) return 'lite'
	if (/\bfull\b/.test(text)) return 'full'
	return undefined
}

export function compressForCaveman(input: string, mode: CavemanMode = 'full'): string {
	if (!input.trim()) return input

	const protectedSegments: string[] = []
	const masked = input.replace(PROTECTED_SEGMENT, segment => {
		const placeholder = `__CAVEMAN_${protectedSegments.length}__`
		protectedSegments.push(segment)
		return placeholder
	})

	const compressed = masked
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(line => compressLine(line, mode))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')

	const restored = protectedSegments.reduce(
		(text, segment, index) => text.replaceAll(`__CAVEMAN_${index}__`, segment),
		compressed,
	)

	return restored.length < input.length ? restored : input
}

function compressLine(line: string, mode: CavemanMode): string {
	if (!line.trim()) return line

	const trimmed = line.trim()
	if (trimmed === '---' || /^\|/.test(trimmed)) return line

	const match = line.match(/^(\s*(?:[-*+]\s+|\d+\.\s+|#+\s+|>\s+)?)?(.*)$/)
	const prefix = match?.[1] ?? ''
	const body = match?.[2] ?? line
	if (prefix.trimStart().startsWith('#')) return line

	if (!/[A-Za-z]/.test(body)) return line

	const compressedBody = compressTextBody(body, mode)
	return compressedBody ? `${prefix}${compressedBody}` : prefix.trimEnd()
}

function compressTextBody(body: string, mode: CavemanMode): string {
	let text = ` ${body} `

	text = text.replace(SAFE_OPENERS, ' ')
	text = text.replace(SAFE_HELPER_PHRASES, ' ')
	text = text.replace(SAFE_FILLER, ' ')

	for (const [pattern, replacement] of SAFE_PHRASE_REPLACEMENTS) {
		text = text.replace(pattern, replacement)
	}

	if (mode !== 'lite') {
		text = text.replace(/\b(?:the|a|an)\b/gi, ' ')
	}

	if (mode === 'ultra') {
		text = text.replace(/\b(?:that|which)\b/gi, ' ')
		text = text.replace(/\bbecause\b/gi, 'cause')
	}

	return text
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')
		.replace(/\s{2,}/g, ' ')
		.trim()
}
