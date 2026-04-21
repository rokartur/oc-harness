import { statSync } from 'node:fs'
import { compressForCaveman, type CavemanMode } from './caveman.js'
import type { ExtraContext } from './instructions.js'

export interface ContextArtifact extends ExtraContext {
	compressed: boolean
	originalChars: number
	artifactChars: number
}

export class ContextArtifactCache {
	private cache = new Map<string, ContextArtifact>()
	private maxEntries: number

	constructor(maxEntries: number = 128) {
		this.maxEntries = maxEntries
	}

	compileAll(contexts: ExtraContext[], mode: CavemanMode): ContextArtifact[] {
		return contexts.map(context => this.compile(context, mode))
	}

	compile(context: ExtraContext, mode: CavemanMode): ContextArtifact {
		const key = buildCacheKey(context, mode)
		const cached = this.cache.get(key)
		if (cached) return cached

		const artifact = buildContextArtifact(context, mode)
		this.cache.set(key, artifact)
		trimCache(this.cache, this.maxEntries)
		return artifact
	}
}

export function buildContextArtifact(context: ExtraContext, mode: CavemanMode): ContextArtifact {
	const original = context.content.trim()
	const shouldCompress = shouldCompressContext(context)
	const content = shouldCompress ? compressForCaveman(original, mode) : original

	return {
		...context,
		content,
		compressed: content !== original,
		originalChars: original.length,
		artifactChars: content.length,
	}
}

function shouldCompressContext(context: ExtraContext): boolean {
	if (context.content.length >= 180) return true
	if (context.label === 'CLAUDE.md' || context.label === 'AGENTS.md' || context.label === 'CaveKit Spec') return true
	if (context.label.startsWith('Rule: ')) return true
	return false
}

function buildCacheKey(context: ExtraContext, mode: CavemanMode): string {
	const mtime = getMtimeMs(context.source)
	return `${mode}:${context.source}:${mtime}:${context.content.length}`
}

function getMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs
	} catch {
		return 0
	}
}

function trimCache<T>(cache: Map<string, T>, maxEntries: number): void {
	while (cache.size > maxEntries) {
		const oldest = cache.keys().next().value
		if (!oldest) return
		cache.delete(oldest)
	}
}
