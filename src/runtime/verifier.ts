import type { VerificationRecord, VerificationStatus } from './types.js'

export function classifyVerification(input: {
	tool: string
	args: { command?: unknown }
	output: { output?: string; metadata?: { exitCode?: unknown } }
}): VerificationRecord | null {
	if (input.tool !== 'bash') return null
	const command = typeof input.args.command === 'string' ? input.args.command.trim() : ''
	if (!command) return null
	if (!/\b(test|build|typecheck|check|lint)\b/i.test(command)) return null

	const exitCode = typeof input.output.metadata?.exitCode === 'number' ? input.output.metadata.exitCode : null
	const body = typeof input.output.output === 'string' ? input.output.output : ''
	return createVerificationRecord(command, body, exitCode)
}

export function createVerificationRecord(
	command: string,
	body: string,
	exitCode: number | null,
	timestamp: number = Date.now(),
): VerificationRecord {
	const status = classifyStatus(exitCode, body)
	return {
		command,
		status,
		summary: summarize(command, status, body, exitCode),
		exitCode,
		timestamp,
	}
}

export function combineVerificationRecords(records: VerificationRecord[]): VerificationRecord | null {
	if (records.length === 0) return null
	const status = summarizeStatuses(records.map(record => record.status))
	const exitCode = status === 'pass' ? 0 : (records.find(record => record.exitCode != null)?.exitCode ?? null)
	const command = records.map(record => record.command).join(' ; ')
	const body = records.map(record => record.summary).join(' | ')
	const timestamp = records[records.length - 1]?.timestamp ?? Date.now()
	return createVerificationRecord(command, body, exitCode, timestamp)
}

function classifyStatus(exitCode: number | null, body: string): VerificationStatus {
	const text = body.toLowerCase()
	if (/\bflaky\b|\bintermittent\b|\bretry\b/.test(text)) return 'flaky'
	if (exitCode === 0) return 'pass'
	if (typeof exitCode === 'number' && exitCode !== 0) return 'fail'
	if (/\bpass(?:ing)?\b|\bsuccess\b|\bgreen\b/.test(text)) return 'pass'
	if (/\bfail(?:ed|ure)?\b|\berror\b|\bred\b/.test(text)) return 'fail'
	return 'unknown'
}

function summarize(command: string, status: VerificationStatus, body: string, exitCode: number | null): string {
	const head = body.replace(/\s+/g, ' ').trim().slice(0, 160)
	const suffix = typeof exitCode === 'number' ? ` exit=${exitCode}` : ''
	return `${command} [${status}${suffix ? ` ${suffix.trim()}` : ''}]${head ? ` ${head}` : ''}`
}

function summarizeStatuses(statuses: VerificationStatus[]): VerificationStatus {
	if (statuses.includes('fail')) return 'fail'
	if (statuses.includes('flaky')) return 'flaky'
	if (statuses.includes('unknown')) return 'unknown'
	return 'pass'
}
