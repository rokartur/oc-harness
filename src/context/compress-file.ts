import { extname } from 'node:path'
import { compressForCaveman, type CavemanMode } from './caveman.js'
import { fileExists, readFileText, writeFileAtomic } from '../shared/fs.js'

export const CAVEMAN_FILE_MODES = ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra'] as const

export type CavemanFileMode = (typeof CAVEMAN_FILE_MODES)[number]

export interface CompressionValidationResult {
	valid: boolean
	missingHeadings: string[]
	missingCodeBlocks: string[]
	missingInlineCode: string[]
	missingUrls: string[]
	missingPaths: string[]
	missingTables: string[]
}

export interface CompressFileResult {
	filePath: string
	backupPath: string
	mode: CavemanFileMode
	originalChars: number
	compressedChars: number
	changed: boolean
	validation: CompressionValidationResult
}

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const MAX_COMPRESSIBLE_CHARS = 200_000

export function compressContextFile(filePath: string, mode: CavemanFileMode = 'full'): CompressFileResult {
	const extension = extname(filePath).toLowerCase()
	if (!SUPPORTED_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported file type for caveman compression: '${extension || 'none'}'`)
	}
	if (!fileExists(filePath)) {
		throw new Error(`File not found: ${filePath}`)
	}

	const original = readFileText(filePath)
	if (original == null) {
		throw new Error(`Failed to read file: ${filePath}`)
	}
	if (original.length > MAX_COMPRESSIBLE_CHARS) {
		throw new Error(`File too large for caveman compression (${original.length} chars)`)
	}

	const backupPath = buildBackupPath(filePath)
	if (!fileExists(backupPath)) {
		writeFileAtomic(backupPath, original)
	}

	const compressed = compressFileContent(original, mode)
	const finalContent = original.endsWith('\n') ? ensureTrailingNewline(compressed) : compressed.replace(/\n$/, '')
	const changed = finalContent !== original
	if (changed) {
		writeFileAtomic(filePath, finalContent)
	}

	return {
		filePath,
		backupPath,
		mode,
		originalChars: original.length,
		compressedChars: finalContent.length,
		changed,
		validation: validateCompressedContent(original, finalContent),
	}
}

export function compressFileContent(content: string, mode: CavemanFileMode = 'full'): string {
	const baseMode = normalizeBaseMode(mode)
	const firstPass = compressForCaveman(content, baseMode)
	if (firstPass === content) return content

	const repaired = applyTargetedFixPass(content, firstPass)
	const validation = validateCompressedContent(content, repaired)
	if (validation.valid && repaired.length < content.length) return repaired

	const fallback = applyMissingTokenFallback(content, repaired, validation)
	const fallbackValidation = validateCompressedContent(content, fallback)
	if (fallbackValidation.valid && fallback.length < content.length) return fallback

	return content
}

export function validateCompressedContent(original: string, compressed: string): CompressionValidationResult {
	const missingHeadings = findMissingTokens(extractHeadingLines(original), compressed)
	const missingCodeBlocks = findMissingTokens(extractCodeBlocks(original), compressed)
	const missingInlineCode = findMissingTokens(extractInlineCode(original), compressed)
	const missingUrls = findMissingTokens(extractUrls(original), compressed)
	const missingPaths = findMissingTokens(extractPaths(original), compressed)
	const missingTables = findMissingTokens(extractTableLines(original), compressed)

	return {
		valid:
			missingHeadings.length === 0 &&
			missingCodeBlocks.length === 0 &&
			missingInlineCode.length === 0 &&
			missingUrls.length === 0 &&
			missingPaths.length === 0 &&
			missingTables.length === 0,
		missingHeadings,
		missingCodeBlocks,
		missingInlineCode,
		missingUrls,
		missingPaths,
		missingTables,
	}
}

function normalizeBaseMode(mode: CavemanFileMode): CavemanMode {
	if (mode === 'lite' || mode === 'wenyan-lite') return 'lite'
	if (mode === 'ultra' || mode === 'wenyan-ultra') return 'ultra'
	return 'full'
}

function buildBackupPath(filePath: string): string {
	const extension = extname(filePath)
	if (!extension) return `${filePath}.original`
	return filePath.slice(0, -extension.length) + `.original${extension}`
}

function applyTargetedFixPass(original: string, compressed: string): string {
	let repaired = compressed
	for (const token of [
		...extractCodeBlocks(original),
		...extractInlineCode(original),
		...extractUrls(original),
		...extractPaths(original),
	]) {
		if (!token || repaired.includes(token)) continue
		const escaped = escapeRegex(compactWhitespace(token))
		const fuzzy = new RegExp(escaped.replace(/\s+/g, '\\s+'), 'i')
		if (fuzzy.test(repaired)) {
			repaired = repaired.replace(fuzzy, token)
		}
	}
	return repaired
}

function applyMissingTokenFallback(
	original: string,
	compressed: string,
	validation: CompressionValidationResult,
): string {
	if (
		validation.missingHeadings.length === 0 &&
		validation.missingTables.length === 0 &&
		validation.missingCodeBlocks.length === 0 &&
		validation.missingInlineCode.length === 0 &&
		validation.missingUrls.length === 0 &&
		validation.missingPaths.length === 0
	) {
		return compressed
	}

	const lines = original.split('\n')
	const protectedLines = new Set<string>()
	for (const line of lines) {
		if (!line.trim()) continue
		if (isHeadingLine(line) || isTableLine(line) || line.includes('```')) {
			protectedLines.add(line)
			continue
		}
		if (extractInlineCode(line).length > 0 || extractUrls(line).length > 0 || extractPaths(line).length > 0) {
			protectedLines.add(line)
		}
	}

	const compressedLines = compressed.split('\n')
	for (const line of protectedLines) {
		if (compressed.includes(line)) continue
		const index = lines.indexOf(line)
		if (index >= 0 && index < compressedLines.length) {
			compressedLines[index] = line
		}
	}

	return compressedLines.join('\n')
}

function findMissingTokens(tokens: string[], compressed: string): string[] {
	const missing = uniqueTokens(tokens).filter(token => token.length > 0 && !compressed.includes(token))
	return missing
}

function extractHeadingLines(input: string): string[] {
	return uniqueTokens(
		input
			.split('\n')
			.map(line => line.trim())
			.filter(isHeadingLine),
	)
}

function extractCodeBlocks(input: string): string[] {
	return uniqueTokens(Array.from(input.matchAll(/```[\s\S]*?```/g), match => match[0]))
}

function extractInlineCode(input: string): string[] {
	return uniqueTokens(Array.from(input.matchAll(/`[^`\n]+`/g), match => match[0]))
}

function extractUrls(input: string): string[] {
	return uniqueTokens(Array.from(input.matchAll(/https?:\/\/\S+/g), match => match[0]))
}

function extractPaths(input: string): string[] {
	return uniqueTokens(
		Array.from(
			input.matchAll(/(?:\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/)+)[A-Za-z0-9_.\-/]+(?:\.[A-Za-z0-9_.-]+)?/g),
			match => match[0],
		),
	)
}

function extractTableLines(input: string): string[] {
	return uniqueTokens(
		input
			.split('\n')
			.map(line => line.trim())
			.filter(isTableLine),
	)
}

function isHeadingLine(line: string): boolean {
	return /^#{1,6}\s+/.test(line)
}

function isTableLine(line: string): boolean {
	return /^\|.+\|?$/.test(line)
}

function uniqueTokens(tokens: string[]): string[] {
	const seen = new Set<string>()
	const ordered: string[] = []
	for (const token of tokens) {
		const trimmed = token.trim()
		if (!trimmed) continue
		if (seen.has(trimmed)) continue
		seen.add(trimmed)
		ordered.push(trimmed)
	}
	return ordered
}

function compactWhitespace(input: string): string {
	return input.replace(/\s+/g, ' ').trim()
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith('\n') ? value : `${value}\n`
}
