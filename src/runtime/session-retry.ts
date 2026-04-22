export interface RetryPromptRecord {
	messageID: string
	text: string
	agent?: string
	model?: {
		providerID: string
		modelID: string
	}
}

export interface SessionRetryOptions {
	enabled?: boolean
	backoffMs?: number
}

export class SessionRetryManager {
	private readonly enabled: boolean
	private readonly backoffMs: number
	private readonly lastPromptBySession = new Map<string, RetryPromptRecord>()
	private readonly retriedMessageIDsBySession = new Map<string, Set<string>>()

	constructor(
		private readonly client: { session?: { promptAsync?: (input: unknown) => Promise<unknown> | unknown } },
		private readonly directory: string,
		options: SessionRetryOptions = {},
	) {
		this.enabled = options.enabled === true
		this.backoffMs = options.backoffMs ?? 2000
	}

	rememberPrompt(sessionID: string, prompt: RetryPromptRecord): void {
		if (!this.enabled) return
		if (!sessionID || !prompt.messageID || !prompt.text.trim()) return
		this.lastPromptBySession.set(sessionID, prompt)
		this.ensureRetrySet(sessionID)
	}

	async handleSessionError(
		event: { type?: string; properties?: Record<string, unknown> },
		sessionID?: string,
	): Promise<boolean> {
		if (!this.enabled) return false
		if (event.type !== 'session.error' || !sessionID) return false
		if (!looksRetryableTimeout(event)) return false
		const prompt = this.lastPromptBySession.get(sessionID)
		const retried = this.ensureRetrySet(sessionID)
		if (!prompt || retried.has(prompt.messageID)) return false
		const promptAsync = this.client.session?.promptAsync
		if (!promptAsync) return false

		retried.add(prompt.messageID)
		while (retried.size > 100) {
			const oldest = retried.values().next().value
			if (!oldest) break
			retried.delete(oldest)
		}
		await sleep(this.backoffMs)
		try {
			await Promise.resolve(
				promptAsync({
					path: { id: sessionID },
					query: { directory: this.directory },
					body: {
						messageID: prompt.messageID,
						agent: prompt.agent,
						model: prompt.model,
						parts: [{ type: 'text', text: prompt.text }],
					},
				}),
			)
			return true
		} catch {
			return false
		}
	}

	reset(sessionID: string): void {
		this.lastPromptBySession.delete(sessionID)
		this.retriedMessageIDsBySession.delete(sessionID)
	}

	private ensureRetrySet(sessionID: string): Set<string> {
		let retried = this.retriedMessageIDsBySession.get(sessionID)
		if (!retried) {
			retried = new Set<string>()
			this.retriedMessageIDsBySession.set(sessionID, retried)
		}
		return retried
	}
}

export function looksRetryableTimeout(event: { properties?: Record<string, unknown> }): boolean {
	const properties = event.properties ?? {}
	const error = (properties.error ?? {}) as Record<string, unknown>
	const name = typeof error.name === 'string' ? error.name : ''
	const nested = error.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
	const message = [nested.message, error.message, properties.message]
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.join(' ')
	const looksLikeTimeout =
		/timed out|timeout|operation timed out|deadline exceeded|etimedout|econnreset|stream.*(abort|closed|ended)/i.test(
			message,
		)
	const abortName = name === 'MessageAbortedError' || name === 'AbortError'
	if (abortName && !looksLikeTimeout) return false
	if (looksLikeTimeout) return true
	return /timeout/i.test(name)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
