import { basename, extname } from 'node:path'
import { statSync } from 'node:fs'

export interface DeltaReadOptions {
	enabled?: boolean
	maxCachePerSession?: number
	maxDiffChars?: number
	excludePatterns?: string[]
}

interface CachedRead {
	content: string
	mtimeMs: number
	readAt: number
}

const DEFAULT_MAX_CACHE = 100
const DEFAULT_MAX_DIFF_CHARS = 1800
const DEFAULT_EXCLUDE = ['.env', '.env.local', '.env.development', '.env.production', '.env.test']
const BINARY_EXTS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.bmp',
	'.svg',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.otf',
	'.zip',
	'.gz',
	'.tar',
	'.bz2',
	'.7z',
	'.rar',
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.mp3',
	'.mp4',
	'.wav',
	'.avi',
	'.mov',
	'.mkv',
	'.sqlite',
	'.db',
	'.wasm',
])

export class DeltaReadManager {
	private readonly sessionCaches = new Map<string, Map<string, CachedRead>>()
	private readonly maxCachePerSession: number
	private readonly maxDiffChars: number
	private readonly excludePatterns: string[]
	private readonly enabled: boolean

	constructor(options: DeltaReadOptions = {}) {
		this.enabled = options.enabled === true
		this.maxCachePerSession = options.maxCachePerSession ?? DEFAULT_MAX_CACHE
		this.maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS
		this.excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDE
	}

	processRead(sessionID: string, filePath: string, output: string): string | null {
		if (!this.enabled) return null
		const normalized = filePath.trim()
		if (!normalized || isExcluded(normalized, this.excludePatterns)) return null

		let stat
		try {
			stat = statSync(normalized)
			if (!stat.isFile()) return null
		} catch {
			return null
		}

		const cache = this.getSessionCache(sessionID)
		const prior = cache.get(normalized)
		const current: CachedRead = {
			content: output,
			mtimeMs: stat.mtimeMs,
			readAt: Date.now(),
		}
		cache.delete(normalized)
		cache.set(normalized, current)

		if (!prior) return null
		if (prior.mtimeMs === current.mtimeMs && prior.content === current.content) {
			return `File unchanged since last read: ${normalized}`
		}

		const diff = buildUnifiedDiff(prior.content, current.content, normalized)
		if (diff && diff.length <= this.maxDiffChars) return diff
		return null
	}

	reset(sessionID: string): void {
		this.sessionCaches.delete(sessionID)
	}

	private getSessionCache(sessionID: string): Map<string, CachedRead> {
		let cache = this.sessionCaches.get(sessionID)
		if (!cache) {
			cache = new Map<string, CachedRead>()
			this.sessionCaches.set(sessionID, cache)
		}
		while (cache.size > this.maxCachePerSession) {
			const oldest = cache.keys().next().value
			if (!oldest) break
			cache.delete(oldest)
		}
		return cache
	}
}

function isExcluded(filePath: string, excludePatterns: string[]): boolean {
	const name = basename(filePath)
	const ext = extname(name).toLowerCase()
	if (BINARY_EXTS.has(ext)) return true
	return excludePatterns.some(pattern => name === pattern || name.startsWith(pattern))
}

function buildUnifiedDiff(previous: string, next: string, filePath: string): string {
	if (previous === next) return ''
	const before = previous.split('\n')
	const after = next.split('\n')
	let prefix = 0
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++

	let suffix = 0
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++
	}

	const removed = before.slice(prefix, before.length - suffix)
	const added = after.slice(prefix, after.length - suffix)
	const contextBefore = before.slice(Math.max(0, prefix - 2), prefix)
	const contextAfter = after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + 2))
	const lines = [`--- previous/${filePath}`, `+++ current/${filePath}`]
	const oldCount = contextBefore.length + removed.length + contextAfter.length
	const newCount = contextBefore.length + added.length + contextAfter.length
	lines.push(
		`@@ -${Math.max(1, prefix - contextBefore.length + 1)},${oldCount} +${Math.max(1, prefix - contextBefore.length + 1)},${newCount} @@`,
	)
	for (const line of contextBefore) lines.push(` ${line}`)
	for (const line of removed) lines.push(`-${line}`)
	for (const line of added) lines.push(`+${line}`)
	for (const line of contextAfter) lines.push(` ${line}`)
	return lines.join('\n')
}
