import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CavemanMode } from '../context/caveman.js'
import type { PluginConfig } from '../shared/types.js'

export interface ResolvedCaveMemSettings {
	dataDir?: string
	compressionIntensity?: CavemanMode
	expandForModel: boolean
	embeddingProvider: string
	searchAlpha: number
	searchDefaultLimit: number
	redactPrivateTags: boolean
	excludePathPatterns: string[]
}

export function resolveCaveMemSettings(options?: Partial<PluginConfig>): ResolvedCaveMemSettings {
	const fileSettings = loadSettingsFile()
	const nested = options?.cavemem && typeof options.cavemem === 'object' ? options.cavemem : {}
	const nestedCompression =
		typeof nested.compression === 'object' && nested.compression != null
			? (nested.compression as Record<string, unknown>)
			: {}
	const nestedEmbedding =
		typeof nested.embedding === 'object' && nested.embedding != null
			? (nested.embedding as Record<string, unknown>)
			: {}
	const nestedSearch =
		typeof nested.search === 'object' && nested.search != null ? (nested.search as Record<string, unknown>) : {}
	const fileCompression =
		typeof fileSettings.compression === 'object' && fileSettings.compression != null
			? (fileSettings.compression as Record<string, unknown>)
			: {}
	const fileEmbedding =
		typeof fileSettings.embedding === 'object' && fileSettings.embedding != null
			? (fileSettings.embedding as Record<string, unknown>)
			: {}
	const fileSearch =
		typeof fileSettings.search === 'object' && fileSettings.search != null
			? (fileSettings.search as Record<string, unknown>)
			: {}

	return {
		dataDir: firstString(options?.cavememDataDir, nested.dataDir, fileSettings.dataDir),
		compressionIntensity: normalizeMode(
			firstString(nestedCompression['intensity'], fileCompression['intensity']) ?? '',
		),
		expandForModel: firstBoolean(nestedCompression['expandForModel'], fileCompression['expandForModel'], false),
		embeddingProvider: firstString(nestedEmbedding['provider'], fileEmbedding['provider']) || 'none',
		searchAlpha: clampNumber(firstNumber(nestedSearch['alpha'], fileSearch['alpha']), 0, 1, 0.65),
		searchDefaultLimit: clampInteger(
			firstNumber(nestedSearch['defaultLimit'], fileSearch['defaultLimit']),
			1,
			50,
			5,
		),
		redactPrivateTags: firstBoolean(nested.redactPrivateTags, fileSettings.redactPrivateTags, true),
		excludePathPatterns: collectStringArray(nested.excludePaths, fileSettings.excludePaths),
	}
}

function loadSettingsFile(): Record<string, unknown> {
	const settingsPath = join(homedir(), '.cavemem', 'settings.json')
	if (!existsSync(settingsPath)) return {}
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function normalizeMode(value: string): CavemanMode | undefined {
	if (value === 'lite' || value === 'full' || value === 'ultra') return value
	return undefined
}

function collectStringArray(...values: unknown[]): string[] {
	const seen = new Set<string>()
	const list: string[] = []
	for (const value of values) {
		if (!Array.isArray(value)) continue
		for (const entry of value) {
			if (typeof entry !== 'string' || !entry.trim()) continue
			const normalized = normalizePattern(entry)
			if (seen.has(normalized)) continue
			seen.add(normalized)
			list.push(normalized)
		}
	}
	return list
}

function normalizePattern(value: string): string {
	if (value === '~') return homedir()
	if (value.startsWith('~/')) return join(homedir(), value.slice(2))
	return value.includes('/') || value.includes('\\') ? resolve(value) : value.trim()
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return undefined
}

function firstBoolean(...values: unknown[]): boolean {
	for (const value of values) {
		if (typeof value === 'boolean') return value
	}
	return false
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) return value
	}
	return undefined
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value == null) return fallback
	return Math.min(max, Math.max(min, value))
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value == null) return fallback
	return Math.min(max, Math.max(min, Math.trunc(value)))
}
