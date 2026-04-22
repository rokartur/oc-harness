import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface LineAnchor {
	line: number
	hash: string
}

export function hashLine(content: string): string {
	return createHash('sha1').update(content).digest('hex').slice(0, 8)
}

export function parseAnchor(anchor: string): LineAnchor {
	const match = /^(\d+)#([0-9a-f]{8})$/i.exec(anchor.trim())
	if (!match) throw new Error(`Invalid anchor format: ${anchor}`)
	const line = Number.parseInt(match[1] ?? '', 10)
	if (!Number.isInteger(line) || line <= 0) throw new Error(`Invalid anchor line: ${anchor}`)
	return { line, hash: (match[2] ?? '').toLowerCase() }
}

export function buildAnchoredViewFromFile(filePath: string): string {
	return buildAnchoredView(readFileSync(filePath, 'utf8'))
}

export function buildAnchoredView(content: string, startLine: number = 1, endLine?: number): string {
	const lines = splitContentLines(content)
	const start = Math.max(1, startLine)
	const end = Math.max(start, Math.min(endLine ?? lines.length, lines.length))
	return lines
		.slice(start - 1, end)
		.map((line, index) => {
			const lineNumber = start + index
			return `${lineNumber}#${hashLine(line)}: ${line}`
		})
		.join('\n')
}

export function splitContentLines(content: string): string[] {
	if (content === '') return []
	const lines = content.split('\n')
	if (content.endsWith('\n')) lines.pop()
	return lines
}
