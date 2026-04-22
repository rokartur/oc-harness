import { spawnSync } from 'node:child_process'

const TIMEOUT_MS = 30_000
const MAX_BUFFER = 10 * 1024 * 1024

export type CodeStatsBackend = 'tokei' | 'scc' | 'rg'

let detectedBackend: { backend: CodeStatsBackend; version?: string } | null | undefined

export function detectCodeStatsBackend(): { backend: CodeStatsBackend; version?: string } | null {
	if (detectedBackend !== undefined) return detectedBackend
	for (const candidate of ['tokei', 'scc', 'rg'] as const) {
		try {
			const result = spawnSync(candidate, ['--version'], {
				timeout: 5000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			if (result.status === 0) {
				detectedBackend = { backend: candidate, version: result.stdout?.split('\n')[0]?.trim() }
				return detectedBackend
			}
		} catch {
			// ignore
		}
	}
	detectedBackend = null
	return null
}

export function resetCodeStatsBackendForTests(): void {
	detectedBackend = undefined
}

export function getCodeStatsReport(targetPath: string): string {
	const backend = detectCodeStatsBackend()
	if (!backend) {
		return 'code-stats unavailable: install `tokei` or `scc`, or ensure `rg` exists for fallback file-type stats.'
	}
	if (backend.backend === 'tokei') return runTokei(targetPath)
	if (backend.backend === 'scc') return runScc(targetPath)
	return runRgFallback(targetPath)
}

function runTokei(path: string): string {
	const result = spawnSync('tokei', ['--output', 'json', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.error) return `tokei failed: ${result.error.message}`
	if (!result.stdout) return result.stderr?.trim() || 'tokei produced no output'
	try {
		const data = JSON.parse(result.stdout) as Record<
			string,
			{ code?: number; comments?: number; reports?: unknown[] }
		>
		const rows = Object.entries(data)
			.filter(([lang]) => lang !== 'Total')
			.map(([lang, stats]) => ({
				lang,
				code: stats.code ?? 0,
				comments: stats.comments ?? 0,
				files: stats.reports?.length ?? 0,
			}))
			.sort((a, b) => b.code - a.code)
		const total = rows.reduce((sum, row) => sum + row.code, 0)
		const totalFiles = rows.reduce((sum, row) => sum + row.files, 0)
		return [
			`Language stats (tokei) — ${rows.length} langs, ${totalFiles} files, ${total} LOC`,
			...rows.map(
				row =>
					`  ${row.lang.padEnd(16)} files=${String(row.files).padStart(5)} code=${String(row.code).padStart(8)} comments=${row.comments}`,
			),
		].join('\n')
	} catch {
		return result.stdout.trim()
	}
}

function runScc(path: string): string {
	const result = spawnSync('scc', ['--format', 'json', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.error) return `scc failed: ${result.error.message}`
	if (!result.stdout) return result.stderr?.trim() || 'scc produced no output'
	try {
		const data = JSON.parse(result.stdout) as Array<{ Name: string; Count: number; Code: number; Comment: number }>
		data.sort((a, b) => b.Code - a.Code)
		const total = data.reduce((sum, row) => sum + row.Code, 0)
		const totalFiles = data.reduce((sum, row) => sum + row.Count, 0)
		return [
			`Language stats (scc) — ${data.length} langs, ${totalFiles} files, ${total} LOC`,
			...data.map(
				row =>
					`  ${row.Name.padEnd(16)} files=${String(row.Count).padStart(5)} code=${String(row.Code).padStart(8)} comments=${row.Comment}`,
			),
		].join('\n')
	} catch {
		return result.stdout.trim()
	}
}

function runRgFallback(path: string): string {
	const result = spawnSync('rg', ['--files', '--hidden', '--no-messages', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (result.error) return `rg failed: ${result.error.message}`
	const lines = (result.stdout ?? '').split('\n').filter(Boolean)
	const extCount = new Map<string, number>()
	for (const line of lines) {
		const dot = line.lastIndexOf('.')
		const ext = dot > 0 ? line.slice(dot) : '(none)'
		extCount.set(ext, (extCount.get(ext) ?? 0) + 1)
	}
	const rows = Array.from(extCount.entries()).sort((a, b) => b[1] - a[1])
	return [
		`File-type stats (rg fallback — install tokei or scc for LOC) — ${lines.length} files, ${rows.length} extensions`,
		...rows.map(([ext, count]) => `  ${ext.padEnd(16)} files=${count}`),
	].join('\n')
}
