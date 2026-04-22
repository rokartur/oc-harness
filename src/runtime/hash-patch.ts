import { readFileSync } from 'node:fs'
import { hashLine, parseAnchor, type LineAnchor } from './line-hash.js'
import { writeFileAtomic } from '../shared/fs.js'

export interface HashPatchOperation {
	anchor?: string
	anchorStart?: string
	anchorEnd?: string
	newContent: string
}

export interface HashPatchResult {
	ok: boolean
	path: string
	report: string[]
	error: string
}

export interface HashPatchOptions {
	maxPatchPayloadBytes?: number
	maxSinglePatchBytes?: number
}

export const DEFAULT_MAX_PATCH_PAYLOAD_BYTES = 8_000
export const DEFAULT_MAX_SINGLE_PATCH_BYTES = 4_000

export function applyHashAnchoredPatches(
	absPath: string,
	patches: HashPatchOperation[],
	options: HashPatchOptions = {},
): HashPatchResult {
	const maxPatchPayloadBytes = options.maxPatchPayloadBytes ?? DEFAULT_MAX_PATCH_PAYLOAD_BYTES
	const maxSinglePatchBytes = options.maxSinglePatchBytes ?? DEFAULT_MAX_SINGLE_PATCH_BYTES
	let totalBytes = 0
	for (let index = 0; index < patches.length; index++) {
		const bytes = Buffer.byteLength(patches[index]?.newContent ?? '', 'utf8')
		if (bytes > maxSinglePatchBytes) {
			return fail(
				absPath,
				`patch ${index + 1}/${patches.length} newContent too large (${bytes} bytes > ${maxSinglePatchBytes})`,
			)
		}
		totalBytes += bytes
	}
	if (totalBytes > maxPatchPayloadBytes) {
		return fail(absPath, `patch payload too large (${totalBytes} bytes > ${maxPatchPayloadBytes})`)
	}

	let originalContent: string
	try {
		originalContent = readFileSync(absPath, 'utf8')
	} catch (error) {
		return fail(absPath, `cannot read ${absPath}: ${error instanceof Error ? error.message : String(error)}`)
	}

	const state = toMutableFileState(originalContent)
	const report: string[] = []
	for (let index = 0; index < patches.length; index++) {
		const patch = patches[index]
		try {
			if (patch.anchorStart || patch.anchorEnd) {
				if (!patch.anchorStart || !patch.anchorEnd) {
					return fail(absPath, `patch ${index + 1}/${patches.length} requires both anchorStart and anchorEnd`)
				}
				const start = parseAnchor(patch.anchorStart)
				const end = parseAnchor(patch.anchorEnd)
				verifyLineAnchor(state.lines, start)
				verifyLineAnchor(state.lines, end)
				if (end.line < start.line) {
					return fail(
						absPath,
						`patch ${index + 1}/${patches.length} anchorEnd must be on or after anchorStart`,
					)
				}
				replaceRange(state.lines, start.line, end.line, patch.newContent)
				report.push(`patch ${index + 1}: lines ${start.line}-${end.line}`)
				continue
			}

			if (!patch.anchor) return fail(absPath, `patch ${index + 1}/${patches.length} requires anchor`)
			const anchor = parseAnchor(patch.anchor)
			verifyLineAnchor(state.lines, anchor)
			replaceRange(state.lines, anchor.line, anchor.line, patch.newContent)
			report.push(`patch ${index + 1}: line ${anchor.line}`)
		} catch (error) {
			return fail(
				absPath,
				`patch ${index + 1}/${patches.length} — ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	try {
		const latestContent = readFileSync(absPath, 'utf8')
		if (latestContent !== originalContent) {
			return fail(absPath, `concurrent modification detected for ${absPath}`)
		}
	} catch (error) {
		return fail(absPath, `cannot re-read ${absPath}: ${error instanceof Error ? error.message : String(error)}`)
	}

	writeFileAtomic(absPath, fromMutableFileState(state))
	return { ok: true, path: absPath, report, error: '' }
}

function verifyLineAnchor(lines: string[], anchor: LineAnchor): void {
	const current = lines[anchor.line - 1]
	if (current === undefined) throw new Error(`anchor line ${anchor.line} is out of range`)
	if (hashLine(current) !== anchor.hash) {
		throw new Error(`hash mismatch at ${anchor.line}; current is ${anchor.line}#${hashLine(current)}: ${current}`)
	}
}

function replaceRange(lines: string[], startLine: number, endLine: number, newContent: string): void {
	const replacement = newContent === '' ? [] : newContent.split('\n')
	lines.splice(startLine - 1, endLine - startLine + 1, ...replacement)
}

function toMutableFileState(content: string): { lines: string[]; trailingNewline: boolean } {
	if (content === '') return { lines: [], trailingNewline: false }
	const trailingNewline = content.endsWith('\n')
	const lines = trailingNewline ? content.slice(0, -1).split('\n') : content.split('\n')
	return { lines, trailingNewline }
}

function fromMutableFileState(state: { lines: string[]; trailingNewline: boolean }): string {
	const content = state.lines.join('\n')
	if (state.trailingNewline && content !== '') return `${content}\n`
	return content
}

function fail(path: string, error: string): HashPatchResult {
	return { ok: false, path, report: [], error }
}
