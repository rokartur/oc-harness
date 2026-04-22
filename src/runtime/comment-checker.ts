export interface CommentCheckerConfig {
	enabled?: boolean
	minViolations?: number
	severity?: 'warn' | 'block'
}

export interface CommentViolation {
	line: string
	category: string
	reason: string
}

export interface CommentCheckResult {
	violations: CommentViolation[]
	warning: string
}

interface SlopPattern {
	category: string
	reason: string
	pattern: RegExp
}

const SLOP_PATTERNS: SlopPattern[] = [
	{
		category: 'narration',
		reason: 'Narrates what the code does instead of explaining why',
		pattern: /^(?:this|the following|here we|now we|first,? we|next,? we|then we|finally,? we)\b/i,
	},
	{
		category: 'narration',
		reason: 'States the obvious — the code already says this',
		pattern: /^(?:set|get|return|create|initialize|define|declare|assign|call|invoke|import)\s+(?:the|a|an)\b/i,
	},
	{
		category: 'over-explanation',
		reason: 'Explains language syntax rather than intent',
		pattern:
			/(?:(?:this|it) (?:is|creates|returns|takes|accepts) (?:a|an|the) (?:new |async )?(?:function|method|class|variable|constant|array|object|promise|string|number|boolean))\b/i,
	},
	{
		category: 'filler',
		reason: 'Marketing-style filler that adds no technical value',
		pattern:
			/\b(?:robust|elegant|seamless|streamlined|leverage|utilize|facilitate|comprehensive|cutting[- ]edge|best[- ]practice|industry[- ]standard|world[- ]class|enterprise[- ]grade|production[- ]ready|battle[- ]tested)\b/i,
	},
	{
		category: 'filler',
		reason: 'Vague hedge word that weakens the comment',
		pattern: /\b(?:basically|essentially|simply|just|actually|obviously|clearly|of course|needless to say)\b/i,
	},
	{
		category: 'section-noise',
		reason: 'Redundant TODO/FIXME with no actionable content',
		pattern: /^(?:todo|fixme|hack|xxx)(?:\s*:)?\s*$/i,
	},
	{
		category: 'politeness',
		reason: 'Conversational tone inappropriate for code comments',
		pattern: /\b(?:please note|feel free|don\'t hesitate|happy to help|hope this helps|let me know)\b/i,
	},
	{
		category: 'changelog',
		reason: 'Inline changelog — use git history instead',
		pattern: /^(?:added|removed|changed|updated|fixed|modified|refactored)\s+(?:by|on|in|for|to)\b/i,
	},
]

export class CommentChecker {
	private readonly config: Required<CommentCheckerConfig>

	constructor(config: CommentCheckerConfig = {}) {
		this.config = {
			enabled: config.enabled ?? true,
			minViolations: config.minViolations ?? 2,
			severity: config.severity ?? 'warn',
		}
	}

	isEnabled(): boolean {
		return this.config.enabled
	}

	getSeverity(): 'warn' | 'block' {
		return this.config.severity
	}

	check(content: string): CommentCheckResult {
		if (!this.config.enabled) return { violations: [], warning: '' }
		const comments = extractComments(content)
		const violations: CommentViolation[] = []
		const seen = new Set<string>()
		for (const { line, text } of comments) {
			if (text.length < 5) continue
			for (const rule of SLOP_PATTERNS) {
				if (!rule.pattern.test(text)) continue
				const key = `${line}:${rule.category}`
				if (seen.has(key)) continue
				seen.add(key)
				violations.push({
					line: line.length > 120 ? `${line.slice(0, 120)}…` : line,
					category: rule.category,
					reason: rule.reason,
				})
				break
			}
		}
		if (violations.length < this.config.minViolations) return { violations, warning: '' }
		const warning = [
			`Comment checker: ${violations.length} low-signal comment(s) detected.`,
			...violations.map(v => `- [${v.category}] ${v.reason} :: ${v.line}`),
			'Write comments that explain why, not what.',
		].join('\n')
		return { violations, warning }
	}
}

function extractComments(content: string): Array<{ line: string; text: string }> {
	const results: Array<{ line: string; text: string }> = []
	const lines = content.split('\n')
	let inBlock = false
	for (const line of lines) {
		const trimmed = line.trim()
		if (!inBlock && /\/\*/.test(trimmed)) {
			inBlock = true
			const after = trimmed.replace(/^.*?\/\*+\s*/, '')
			if (after && !after.startsWith('*')) {
				results.push({ line: trimmed, text: after.replace(/\*\/\s*$/, '').trim() })
			}
		}
		if (inBlock) {
			if (/\*\//.test(trimmed)) {
				inBlock = false
				const before = trimmed
					.replace(/\*\/.*$/, '')
					.replace(/^\s*\*?\s*/, '')
					.trim()
				if (before) results.push({ line: trimmed, text: before })
			} else {
				const body = trimmed.replace(/^\s*\*?\s*/, '').trim()
				if (body) results.push({ line: trimmed, text: body })
			}
			continue
		}
		const singleMatch = trimmed.match(/^(?:\/\/|#)\s*(.+)/)
		if (singleMatch) results.push({ line: trimmed, text: singleMatch[1]?.trim() ?? '' })
	}
	return results
}
