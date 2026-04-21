import type { CompiledPrompt, PromptConstraint, ConstraintKind } from './types.js'

const STOP_WORDS = new Set([
	'please',
	'with',
	'from',
	'that',
	'this',
	'into',
	'about',
	'after',
	'before',
	'should',
	'could',
	'would',
	'need',
	'needs',
	'like',
	'just',
	'very',
	'keep',
	'make',
	'using',
	'without',
	'under',
	'when',
	'then',
	'also',
	'have',
	'into',
])

const CONSTRAINT_PATTERNS: Array<{ kind: ConstraintKind; pattern: RegExp }> = [
	{ kind: 'avoid', pattern: /\b(?:without|avoid|do not|don't|never)\b[^.,;\n]*/gi },
	{ kind: 'must', pattern: /\b(?:must|need to|has to|required to)\b[^.,;\n]*/gi },
	{ kind: 'use', pattern: /\b(?:use|using)\b[^.,;\n]*/gi },
	{ kind: 'prefer', pattern: /\b(?:prefer|keep|preserve)\b[^.,;\n]*/gi },
	{ kind: 'scope', pattern: /\b(?:only|scope|focus on)\b[^.,;\n]*/gi },
]

export function compileUserPrompt(input: string): CompiledPrompt {
	const normalized = normalizePrompt(input)
	return {
		raw: input,
		normalized,
		goal: extractGoal(normalized),
		constraints: extractConstraints(normalized),
		keywords: extractKeywords(normalized),
	}
}

function normalizePrompt(input: string): string {
	return input.replace(/\s+/g, ' ').trim()
}

function extractGoal(normalized: string): string {
	if (!normalized) return ''
	const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0] ?? normalized
	return firstSentence.slice(0, 240).trim()
}

function extractConstraints(normalized: string): PromptConstraint[] {
	const constraints: PromptConstraint[] = []
	for (const { kind, pattern } of CONSTRAINT_PATTERNS) {
		for (const match of normalized.matchAll(pattern)) {
			const text = match[0]?.trim()
			if (!text) continue
			if (!constraints.some(existing => existing.text.toLowerCase() === text.toLowerCase())) {
				constraints.push({ kind, text })
			}
		}
	}
	return constraints.slice(0, 6)
}

function extractKeywords(normalized: string): string[] {
	const tokens = normalized.toLowerCase().match(/[a-z0-9_/-]+/g) ?? []
	const seen = new Set<string>()
	const keywords: string[] = []
	for (const token of tokens) {
		if (token.length < 4) continue
		if (STOP_WORDS.has(token)) continue
		if (seen.has(token)) continue
		seen.add(token)
		keywords.push(token)
		if (keywords.length >= 10) break
	}
	return keywords
}
