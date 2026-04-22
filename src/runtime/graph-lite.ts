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

export interface GraphLiteSymbolRef {
	symbolName: string
	sourcePath: string
}

export interface GraphLiteBlastRadiusDetail {
	count: number
	files: string[]
	scores: Array<{ path: string; depth: number }>
}

export interface GraphLiteCoChangeHint {
	path: string
	sharedDependents: number
	sharedDependencies: number
	score: number
}

export interface GraphLitePackageGroup {
	directory: string
	files: string[]
	symbolCount: number
	edgeCount: number
}

export interface GraphLiteFile {
	path: string
	lineCount: number
	dependencies: string[]
	dependents: string[]
	symbols: GraphLiteSymbol[]
	symbolRefs: GraphLiteSymbolRef[]
	score: number
}

export interface GraphLiteStats {
	files: number
	symbols: number
	edges: number
	symbolRefs: number
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
				const symbolRefs = extractSymbolRefs(content, absPath, this.cwd)
				fileMap.set(relPath, {
					path: relPath,
					lineCount,
					dependencies,
					dependents: [],
					symbols,
					symbolRefs,
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
				symbolRefs: files.reduce((sum, file) => sum + file.symbolRefs.length, 0),
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
		return this.getBlastRadiusDetail(path).count
	}

	getBlastRadiusDetail(path: string): GraphLiteBlastRadiusDetail {
		const start = this.findFile(path)
		if (!start) return { count: 0, files: [], scores: [] }
		const queue: Array<{ path: string; depth: number }> = start.dependents.map(d => ({ path: d, depth: 1 }))
		const seen = new Map<string, number>()
		for (const dep of start.dependents) {
			if (!seen.has(dep)) seen.set(dep, 1)
		}
		while (queue.length > 0) {
			const next = queue.shift()!
			const currentDepth = seen.get(next.path) ?? next.depth
			for (const dependent of this.getFileDependents(next.path)) {
				if (!seen.has(dependent)) {
					const newDepth = currentDepth + 1
					seen.set(dependent, newDepth)
					queue.push({ path: dependent, depth: newDepth })
				}
			}
		}
		const files = Array.from(seen.keys()).sort()
		const scores = Array.from(seen.entries())
			.map(([p, depth]) => ({ path: p, depth }))
			.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
		return { count: seen.size, files, scores }
	}

	searchSymbols(query: string, limit: number = 20): Array<{ symbol: GraphLiteSymbol; filePath: string }> {
		if (!this.index) return []
		const needle = query.toLowerCase().trim()
		if (!needle) return []
		const results: Array<{ symbol: GraphLiteSymbol; filePath: string; matchScore: number }> = []
		for (const file of this.index.files) {
			for (const symbol of file.symbols) {
				const lower = symbol.name.toLowerCase()
				let matchScore = 0
				if (lower === needle) matchScore = 4
				else if (lower.startsWith(needle)) matchScore = 3
				else if (lower.includes(needle)) matchScore = 2
				else if (needle.split('').every(ch => lower.includes(ch))) matchScore = 1
				if (matchScore > 0) {
					results.push({ symbol, filePath: file.path, matchScore })
				}
			}
		}
		return results
			.sort((a, b) => b.matchScore - a.matchScore || a.filePath.localeCompare(b.filePath))
			.slice(0, limit)
			.map(({ symbol, filePath }) => ({ symbol, filePath }))
	}

	getCallers(filePath: string, symbolName: string): Array<{ filePath: string; symbolName: string }> {
		const results: Array<{ filePath: string; symbolName: string }> = []
		if (!this.index) return results
		const targetLower = symbolName.toLowerCase()
		for (const file of this.index.files) {
			if (file.path === filePath) continue
			for (const ref of file.symbolRefs) {
				if (ref.sourcePath === filePath && ref.symbolName.toLowerCase() === targetLower) {
					results.push({ filePath: file.path, symbolName: ref.symbolName })
				}
			}
		}
		return results
	}

	getCallees(filePath: string): Array<{ symbolName: string; sourcePath: string }> {
		return this.findFile(filePath)?.symbolRefs ?? []
	}

	getCoChangeHints(path: string, limit: number = 10): GraphLiteCoChangeHint[] {
		const target = this.findFile(path)
		if (!target || !this.index) return []
		const targetDependents = new Set(target.dependents)
		const targetDeps = new Set(target.dependencies)
		const hints: GraphLiteCoChangeHint[] = []
		for (const file of this.index.files) {
			if (file.path === target.path) continue
			const sharedDependents = file.dependents.filter(d => targetDependents.has(d)).length
			const sharedDependencies = file.dependencies.filter(d => targetDeps.has(d)).length
			const score = sharedDependents * 3 + sharedDependencies * 2
			if (score > 0) {
				hints.push({ path: file.path, sharedDependents, sharedDependencies, score })
			}
		}
		return hints.sort((a, b) => b.score - a.score).slice(0, limit)
	}

	getPackageGroups(): GraphLitePackageGroup[] {
		if (!this.index) return []
		const groups = new Map<string, GraphLitePackageGroup>()
		for (const file of this.index.files) {
			const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.'
			const existing = groups.get(dir)
			if (existing) {
				existing.files.push(file.path)
				existing.symbolCount += file.symbols.length
				existing.edgeCount += file.dependencies.length
			} else {
				groups.set(dir, {
					directory: dir,
					files: [file.path],
					symbolCount: file.symbols.length,
					edgeCount: file.dependencies.length,
				})
			}
		}
		return Array.from(groups.values()).sort(
			(a, b) => b.files.length - a.files.length || a.directory.localeCompare(b.directory),
		)
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

function extractSymbolRefs(content: string, absPath: string, cwd: string): GraphLiteSymbolRef[] {
	const refs: GraphLiteSymbolRef[] = []
	const pattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
	for (const match of content.matchAll(pattern)) {
		const names = match[1]?.trim()
		const specifier = match[2]?.trim()
		if (!names || !specifier || !specifier.startsWith('.')) continue
		const resolved = resolveImportSpecifier(absPath, specifier, cwd)
		if (!resolved) continue
		for (const name of names.split(',')) {
			const clean = name
				.trim()
				.replace(/\s+as\s+\w+$/, '')
				.trim()
			if (clean) refs.push({ symbolName: clean, sourcePath: resolved })
		}
	}
	return refs
}

function normalizeQueryPath(path: string): string {
	return path.replace(/^\.\//, '').trim()
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values))
}
