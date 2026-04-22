export type RecoveryClass = 'transient-timeout' | 'overload' | 'context-overflow' | 'unknown'

export interface RecoveryPolicy {
	maxRetries: number
	backoffBaseMs: number
	backoffMultiplier: number
	maxBackoffMs: number
	classification: RecoveryClass
}

export interface RecoveryAttempt {
	timestamp: number
	classification: RecoveryClass
	retryNumber: number
	backoffMs: number
	success: boolean
	messageID: string
	errorSnippet: string
}

export interface RecoveryAuditEntry {
	sessionID: string
	attempts: RecoveryAttempt[]
	totalRetries: number
	lastClassification: RecoveryClass | null
}

const DEFAULT_POLICIES: Record<RecoveryClass, Omit<RecoveryPolicy, 'classification'>> = {
	'transient-timeout': { maxRetries: 3, backoffBaseMs: 2000, backoffMultiplier: 2, maxBackoffMs: 30000 },
	overload: { maxRetries: 2, backoffBaseMs: 5000, backoffMultiplier: 2, maxBackoffMs: 60000 },
	'context-overflow': { maxRetries: 1, backoffBaseMs: 1000, backoffMultiplier: 1, maxBackoffMs: 2000 },
	unknown: { maxRetries: 1, backoffBaseMs: 3000, backoffMultiplier: 2, maxBackoffMs: 15000 },
}

export class SessionRecoveryManager {
	private readonly audits = new Map<string, RecoveryAuditEntry>()
	private readonly maxAuditEntries = 50

	constructor(
		private readonly client: { session?: { promptAsync?: (input: unknown) => Promise<unknown> | unknown } },
		private readonly directory: string,
		private readonly options: { enabled?: boolean } = {},
	) {}

	isEnabled(): boolean {
		return this.options.enabled === true
	}

	classifyError(event: { type?: string; properties?: Record<string, unknown> }): RecoveryClass {
		const properties = event.properties ?? {}
		const error = (properties.error ?? {}) as Record<string, unknown>
		const name = typeof error.name === 'string' ? error.name : ''
		const nested = error.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
		const message = [nested.message, error.message, properties.message]
			.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
			.join(' ')
			.toLowerCase()

		if (/\bcontext\b.*\boverflow\b|\boverflow\b.*\bcontext\b|\btoken\b.*\blimit\b|\bmax.?token/i.test(message)) {
			return 'context-overflow'
		}
		if (/\boverload\b|\b429\b|\brate.?limit\b|\btoo.?many.?request/i.test(message)) {
			return 'overload'
		}
		if (
			/timed?[\s-]?out|timeout|deadline exceeded|etimedout|econnreset|stream.*(abort|closed|ended)/i.test(
				message,
			) ||
			/timeout/i.test(name) ||
			name === 'MessageAbortedError'
		) {
			return 'transient-timeout'
		}
		return 'unknown'
	}

	getPolicy(classification: RecoveryClass): RecoveryPolicy {
		const base = DEFAULT_POLICIES[classification] ?? DEFAULT_POLICIES['unknown']
		return { ...base, classification }
	}

	canRetry(sessionID: string, classification: RecoveryClass): boolean {
		if (!this.options.enabled) return false
		const audit = this.audits.get(sessionID)
		const policy = this.getPolicy(classification)
		if (!audit) return true
		return audit.attempts.filter(a => a.classification === classification).length < policy.maxRetries
	}

	calculateBackoff(retryNumber: number, classification: RecoveryClass): number {
		const policy = this.getPolicy(classification)
		const backoff = policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, retryNumber - 1)
		return Math.min(backoff, policy.maxBackoffMs)
	}

	recordAttempt(
		sessionID: string,
		classification: RecoveryClass,
		retryNumber: number,
		messageID: string,
		errorSnippet: string,
		success: boolean,
	): void {
		const audit = this.getOrCreateAudit(sessionID)
		const backoffMs = this.calculateBackoff(retryNumber, classification)
		audit.attempts.push({
			timestamp: Date.now(),
			classification,
			retryNumber,
			backoffMs,
			success,
			messageID,
			errorSnippet: errorSnippet.slice(0, 200),
		})
		audit.totalRetries = audit.attempts.length
		audit.lastClassification = classification
		while (audit.attempts.length > 100) audit.attempts.shift()
		this.trimAudits()
	}

	async handleSessionError(
		event: { type?: string; properties?: Record<string, unknown> },
		sessionID?: string,
		lastPrompt?: {
			messageID: string
			text: string
			agent?: string
			model?: { providerID: string; modelID: string }
		},
	): Promise<boolean> {
		if (!this.options.enabled || !sessionID || event.type !== 'session.error') return false

		const classification = this.classifyError(event)
		const policy = this.getPolicy(classification)
		const audit = this.getOrCreateAudit(sessionID)
		const retryCount = audit.attempts.filter(a => a.classification === classification).length

		if (retryCount >= policy.maxRetries) {
			this.recordAttempt(
				sessionID,
				classification,
				retryCount + 1,
				lastPrompt?.messageID ?? '',
				truncateError(event),
				false,
			)
			return false
		}

		if (!lastPrompt?.text.trim() || !lastPrompt?.messageID) return false

		const retriedIDs = new Set(audit.attempts.map(a => a.messageID))
		if (retriedIDs.has(lastPrompt.messageID)) return false

		const backoffMs = this.calculateBackoff(retryCount + 1, classification)
		const promptAsync = this.client.session?.promptAsync
		if (!promptAsync) return false

		this.recordAttempt(sessionID, classification, retryCount + 1, lastPrompt.messageID, truncateError(event), false)

		await sleep(backoffMs)

		try {
			await Promise.resolve(
				promptAsync({
					path: { id: sessionID },
					query: { directory: this.directory },
					body: {
						messageID: lastPrompt.messageID,
						agent: lastPrompt.agent,
						model: lastPrompt.model,
						parts: [{ type: 'text', text: lastPrompt.text }],
					},
				}),
			)
			this.recordAttempt(sessionID, classification, retryCount + 1, lastPrompt.messageID, '', true)
			return true
		} catch {
			return false
		}
	}

	getAudit(sessionID: string): RecoveryAuditEntry | null {
		return this.audits.get(sessionID) ?? null
	}

	renderAudit(sessionID: string): string {
		const audit = this.audits.get(sessionID)
		if (!audit || audit.attempts.length === 0) return 'No recovery attempts recorded.'

		const lines: string[] = [
			'## Session Recovery Audit',
			'',
			`Session: ${sessionID}`,
			`Total retries: ${audit.totalRetries}`,
			`Last classification: ${audit.lastClassification ?? 'n/a'}`,
			'',
			'### Attempts',
		]

		for (const attempt of audit.attempts.slice(-20)) {
			const time = new Date(attempt.timestamp).toISOString().slice(11, 19)
			const status = attempt.success ? 'OK' : 'RETRY'
			lines.push(
				`- [${time}] ${attempt.classification} retry=${attempt.retryNumber} backoff=${attempt.backoffMs}ms ${status}${attempt.errorSnippet ? ` — ${attempt.errorSnippet.slice(0, 80)}` : ''}`,
			)
		}

		return lines.join('\n')
	}

	reset(sessionID: string): void {
		this.audits.delete(sessionID)
	}

	private getOrCreateAudit(sessionID: string): RecoveryAuditEntry {
		let audit = this.audits.get(sessionID)
		if (!audit) {
			audit = { sessionID, attempts: [], totalRetries: 0, lastClassification: null }
			this.audits.set(sessionID, audit)
		}
		return audit
	}

	private trimAudits(): void {
		while (this.audits.size > this.maxAuditEntries) {
			const oldest = this.audits.keys().next().value
			if (!oldest) break
			this.audits.delete(oldest)
		}
	}
}

export function truncateError(event: { properties?: Record<string, unknown> }): string {
	const properties = event.properties ?? {}
	const error = (properties.error ?? {}) as Record<string, unknown>
	const parts: string[] = []
	if (typeof error.name === 'string') parts.push(error.name)
	const nested = error.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
	const msg =
		typeof nested.message === 'string' ? nested.message : typeof error.message === 'string' ? error.message : ''
	if (msg) parts.push(msg)
	if (typeof properties.message === 'string') parts.push(properties.message)
	return parts.join(': ').slice(0, 200)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
