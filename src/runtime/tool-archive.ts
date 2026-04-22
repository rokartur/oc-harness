import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { ensureDir, fileExists, listDirEntries, readFileText, writeFileAtomic } from '../shared/fs.js'

export interface ToolArchiveOptions {
	enabled?: boolean
	thresholdChars?: number
	exemptTools?: string[]
	maxEntries?: number
	maxEntriesPerSession?: number
}

export interface ToolArchiveEntry {
	id: string
	sessionID: string
	toolName: string
	charCount: number
	createdAt: number
	preview: string
	output: string
}

const DEFAULT_THRESHOLD = 4096
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_ENTRIES_PER_SESSION = 50
const DEFAULT_EXEMPT_TOOLS = [
	'openharness_expand',
	'expand',
	'openharness_cavekit_spec',
	'openharness_cavekit_build',
	'openharness_cavekit_check',
	'openharness_runtime_status',
	'openharness_hook_log',
]

export class ToolArchiveManager {
	private readonly enabled: boolean
	private readonly thresholdChars: number
	private readonly exemptTools: Set<string>
	private readonly maxEntries: number
	private readonly maxEntriesPerSession: number

	constructor(
		private readonly archiveDir: string,
		options: ToolArchiveOptions = {},
	) {
		this.enabled = options.enabled === true
		this.thresholdChars = options.thresholdChars ?? DEFAULT_THRESHOLD
		this.exemptTools = new Set([...(options.exemptTools ?? []), ...DEFAULT_EXEMPT_TOOLS])
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
		this.maxEntriesPerSession = options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES_PER_SESSION
	}

	archive(sessionID: string, toolName: string, output: string): ToolArchiveEntry {
		ensureDir(this.archiveDir)
		this.prune(sessionID)
		const createdAt = Date.now()
		const id = createArchiveId(sessionID, toolName, createdAt, output)
		const entry: ToolArchiveEntry = {
			id,
			sessionID,
			toolName,
			charCount: output.length,
			createdAt,
			preview: buildPreview(output),
			output,
		}
		writeFileAtomic(join(this.archiveDir, `${id}.json`), JSON.stringify(entry, null, 2))
		this.prune(sessionID)
		return entry
	}

	maybeArchive(sessionID: string, toolName: string, output: string): ToolArchiveEntry | null {
		if (!this.enabled) return null
		if (!output || output.length < this.thresholdChars) return null
		if (this.exemptTools.has(toolName)) return null
		return this.archive(sessionID, toolName, output)
	}

	retrieve(id: string): ToolArchiveEntry | null {
		const raw = readFileText(join(this.archiveDir, `${id}.json`))
		if (!raw) return null
		try {
			return JSON.parse(raw) as ToolArchiveEntry
		} catch {
			return null
		}
	}

	list(sessionID?: string): ToolArchiveEntry[] {
		if (!fileExists(this.archiveDir)) return []
		const entries: ToolArchiveEntry[] = []
		for (const entry of listDirEntries(this.archiveDir)) {
			if (!entry.endsWith('.json')) continue
			const value = this.retrieve(entry.replace(/\.json$/i, ''))
			if (!value) continue
			if (sessionID && value.sessionID !== sessionID) continue
			entries.push(value)
		}
		return entries.sort((left, right) => right.createdAt - left.createdAt)
	}

	private prune(sessionID: string): void {
		if (!fileExists(this.archiveDir)) return
		const all = this.list()
		const staleAll = all.slice(this.maxEntries)
		for (const entry of staleAll) this.remove(entry.id)
		const perSession = this.list(sessionID).slice(this.maxEntriesPerSession)
		for (const entry of perSession) this.remove(entry.id)
	}

	private remove(id: string): void {
		try {
			rmSync(join(this.archiveDir, `${id}.json`), { force: true })
		} catch {
			// ignore cleanup issues
		}
	}
}

export function formatArchivedOutput(entry: ToolArchiveEntry): string {
	return [
		entry.preview,
		'',
		`... (${entry.charCount} chars total, archived)`,
		`[Use openharness_expand id=\"${entry.id}\" to retrieve the full output.]`,
	].join('\n')
}

function buildPreview(output: string): string {
	return output.split('\n').slice(0, 8).join('\n').trim()
}

function createArchiveId(sessionID: string, toolName: string, createdAt: number, output: string): string {
	const hash = createHash('sha1')
	hash.update(`${sessionID}:${toolName}:${createdAt}:${output.slice(0, 256)}`)
	return hash.digest('hex').slice(0, 12)
}
