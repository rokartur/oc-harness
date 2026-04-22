import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { ensureDir, fileExists, readFileText, writeFileAtomic } from '../shared/fs.js'

export type GraphLiteState = 'unavailable' | 'scanning' | 'ready' | 'stale' | 'error'

export interface GraphLiteSymbol {
	name: string
	kind: string
	line: number
	isExported: boolean
}

export interface GraphLiteFile {
	path: string
	lineCount: number
	dependencies: string[]
	dependents: string[]
	symbols: GraphLiteSymbol[]
	score: number
}

export interface GraphLiteStats {
	files: number
	symbols: number
	edges: number
}

export interface GraphLiteStatus {
	state: GraphLiteState
	ready: boolean
	updatedAt: number
	message?: string
	stats?: GraphLiteStats
}

interface GraphLiteIndex {
	updatedAt: number
	stats: GraphLiteStats
	files: GraphLiteFile[]
}

const INDEXABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.openharness'])

export class GraphLiteService {
	private status: GraphLiteStatus
	private index: GraphLiteIndex | null = null

	constructor(
		private readonly cwd: string,
		private readonly cacheDir: string,
		private readonly enabled: boolean,
		private readonly maxFiles: number = 2000,
		private readonly staleAfterMs: number = 15 * 60 * 1000,
	) {
		this.status = this.enabled
			? { state: 'unavailable', ready: false, updatedAt: 0 }
			: { state: 'unavailable', ready: false, updatedAt: 0, message: 'graph-lite disabled' }
		this.loadFromDisk()
	}

	getStatus(): GraphLiteStatus {
		this.refreshFreshness()
		return { ...this.status }
	}

	async scan(): Promise<GraphLiteStatus> {
		if (!this.enabled) {
			this.status = { state: 'unavailable', ready: false, updatedAt: Date.now(), message: 'graph-lite disabled' }
			return this.getStatus()
		}
		try {
			this.status = { state: 'scanning', ready: false, updatedAt: Date.now(), message: 'scanning repository' }
			const filePaths = walkIndexableFiles(this.cwd, this.maxFiles)
			const fileMap = new Map<string, GraphLiteFile>()
			for (const relPath of filePaths) {
				const absPath = resolve(this.cwd, relPath)
				const content = readFileText(absPath)
				if (!content) continue
				const dependencies = extractDependencies(content, absPath, this.cwd)
				const symbols = extractSymbols(content)
				const lineCount = content.split('\n').length
				fileMap.set(relPath, {
					path: relPath,
					lineCount,
					dependencies,
					dependents: [],
					symbols,
					score: 0,
				})
			}
			for (const file of fileMap.values()) {
				file.dependencies = file.dependencies.filter(dep => fileMap.has(dep))
				for (const dep of file.dependencies) fileMap.get(dep)?.dependents.push(file.path)
			}
			for (const file of fileMap.values()) {
				file.dependents = uniqueStrings(file.dependents)
				file.score =
					file.dependents.length * 3 +
					file.dependencies.length +
					file.symbols.length * 0.5 +
					file.lineCount / 200
			}
			const files = Array.from(fileMap.values()).sort(
				(left, right) => right.score - left.score || left.path.localeCompare(right.path),
			)
			const stats: GraphLiteStats = {
				files: files.length,
				symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
				edges: files.reduce((sum, file) => sum + file.dependencies.length, 0),
			}
			this.index = { updatedAt: Date.now(), stats, files }
			this.status = { state: 'ready', ready: true, updatedAt: this.index.updatedAt, stats }
			this.persist()
			return this.getStatus()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.status = { state: 'error', ready: false, updatedAt: Date.now(), message }
			this.persistStatus()
			return this.getStatus()
		}
	}

	getTopFiles(limit: number = 10): Array<{ path: string; score: number; lines: number; symbols: number }> {
		return (this.index?.files ?? []).slice(0, limit).map(file => ({
			path: file.path,
			score: file.score,
			lines: file.lineCount,
			symbols: file.symbols.length,
		}))
	}

	getFileSymbols(path: string): GraphLiteSymbol[] {
		return this.findFile(path)?.symbols ?? []
	}

	getFileDependencies(path: string): string[] {
		return this.findFile(path)?.dependencies ?? []
	}

	getFileDependents(path: string): string[] {
		return this.findFile(path)?.dependents ?? []
	}

	getBlastRadius(path: string): number {
		const start = this.findFile(path)
		if (!start) return 0
		const queue = [...start.dependents]
		const seen = new Set<string>()
		while (queue.length > 0) {
			const next = queue.shift()!
			if (seen.has(next)) continue
			seen.add(next)
			for (const dependent of this.getFileDependents(next)) {
				if (!seen.has(dependent)) queue.push(dependent)
			}
		}
		return seen.size
	}

	private findFile(path: string): GraphLiteFile | null {
		const normalized = normalizeQueryPath(path)
		return (
			(this.index?.files ?? []).find(file => file.path === normalized || file.path.endsWith(normalized)) ?? null
		)
	}

	private loadFromDisk(): void {
		const rawIndex = readFileText(join(this.cacheDir, 'index.json'))
		const rawStatus = readFileText(join(this.cacheDir, 'status.json'))
		if (rawIndex) {
			try {
				this.index = JSON.parse(rawIndex) as GraphLiteIndex
			} catch {
				this.index = null
			}
		}
		if (rawStatus) {
			try {
				this.status = JSON.parse(rawStatus) as GraphLiteStatus
			} catch {
				// ignore corrupted status
			}
		}
		this.refreshFreshness()
	}

	private persist(): void {
		ensureDir(this.cacheDir)
		if (this.index) writeFileAtomic(join(this.cacheDir, 'index.json'), JSON.stringify(this.index, null, 2))
		this.persistStatus()
	}

	private persistStatus(): void {
		ensureDir(this.cacheDir)
		writeFileAtomic(join(this.cacheDir, 'status.json'), JSON.stringify(this.status, null, 2))
	}

	private refreshFreshness(): void {
		if (!this.enabled) return
		if (!this.index || this.index.files.length === 0) return
		const ageMs = Date.now() - this.index.updatedAt
		if (ageMs > this.staleAfterMs) {
			this.status = {
				state: 'stale',
				ready: false,
				updatedAt: this.index.updatedAt,
				stats: this.index.stats,
				message: `index stale (${Math.round(ageMs / 1000)}s old)`,
			}
			return
		}
		this.status = { state: 'ready', ready: true, updatedAt: this.index.updatedAt, stats: this.index.stats }
	}
}

function walkIndexableFiles(cwd: string, maxFiles: number): string[] {
	const files: string[] = []
	function walk(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const absPath = join(dir, entry)
			const relPath = relative(cwd, absPath)
			let stat
			try {
				stat = statSync(absPath)
			} catch {
				continue
			}
			if (stat.isDirectory()) {
				if (IGNORED_DIRS.has(entry)) continue
				walk(absPath)
				continue
			}
			if (!INDEXABLE_EXTS.has(extname(entry).toLowerCase())) continue
			files.push(relPath)
			if (files.length >= maxFiles) return
		}
	}
	if (fileExists(cwd)) walk(cwd)
	return files.sort()
}

function extractDependencies(content: string, absPath: string, cwd: string): string[] {
	const deps = new Set<string>()
	const patterns = [
		/(?:import|export)\s+[^\n]*?from\s+['\"]([^'\"]+)['\"]/g,
		/require\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
		/import\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
	]
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) {
			const specifier = match[1]?.trim()
			if (!specifier || !specifier.startsWith('.')) continue
			const resolved = resolveImportSpecifier(absPath, specifier, cwd)
			if (resolved) deps.add(resolved)
		}
	}
	return Array.from(deps).sort()
}

function resolveImportSpecifier(fromFile: string, specifier: string, cwd: string): string | null {
	const base = resolve(dirname(fromFile), specifier)
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		join(base, 'index.ts'),
		join(base, 'index.tsx'),
		join(base, 'index.js'),
		join(base, 'index.jsx'),
	]
	for (const candidate of candidates) {
		if (!fileExists(candidate)) continue
		return relative(cwd, candidate)
	}
	return null
}

function extractSymbols(content: string): GraphLiteSymbol[] {
	const symbols: GraphLiteSymbol[] = []
	const seen = new Set<string>()
	const lines = content.split('\n')
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		const match =
			line.match(/^\s*(export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?let\s+([A-Za-z_$][\w$]*)/)
		if (!match) continue
		const name = match[2]
		if (!name || seen.has(name)) continue
		seen.add(name)
		const exported = Boolean(match[1]?.trim())
		const keyword =
			line
				.replace(/^\s*export\s+/, '')
				.trim()
				.split(/\s+/)[0] ?? 'symbol'
		symbols.push({ name, kind: keyword, line: index + 1, isExported: exported })
	}
	return symbols
}

function normalizeQueryPath(path: string): string {
	return path.replace(/^\.\//, '').trim()
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values))
}
