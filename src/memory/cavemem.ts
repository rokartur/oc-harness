import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { compressForCaveman, type CavemanMode } from '../context/caveman.js'
import type { MemoryHeader } from './scan.js'
import { resolveCaveMemSettings, type ResolvedCaveMemSettings } from './settings.js'
import { cosineSimilarity, createEmbeddingVector, normalizeEmbeddingProvider } from './embeddings.js'

interface SqliteStatement {
	run(...params: unknown[]): unknown
	get(...params: unknown[]): Record<string, unknown> | undefined
	all(...params: unknown[]): Record<string, unknown>[]
}

interface SqliteDatabase {
	exec(sql: string): void
	prepare(sql: string): SqliteStatement
	close(): void
}

interface SqliteAdapter {
	open(path: string): SqliteDatabase
}

const SQLITE = await loadSqliteAdapter()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ide TEXT NOT NULL,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_observations_ts ON observations(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
`

export interface CaveMemOptions {
	dataDir?: string
	mode?: CavemanMode
	redactPrivateTags?: boolean
	excludePathPatterns?: string[]
	expandForModel?: boolean
	embeddingProvider?: string
	searchAlpha?: number
	searchDefaultLimit?: number
}

export interface CaveMemObservation {
	id: number
	sessionID: string
	kind: string
	event: string
	content: string
	timestamp: number
	intensity: string | null
	metadata: Record<string, unknown>
}

export interface CaveMemSessionInfo {
	sessionID: string
	cwd: string
	startedAt: number
	endedAt: number | null
	observationCount: number
	lastEventAt: number
}

export interface CaveMemReindexResult {
	provider: string
	scanned: number
	updated: number
}

interface CaveMemSearchRow {
	id: number
	session_id: string
	kind: string
	content: string
	intensity: string | null
	ts: number
	metadata: string | null
	snippet: string
	score: number
}

export function startCaveMemSession(sessionID: string, cwd: string, options: CaveMemOptions = {}): void {
	if (!sessionID) return
	const settings = getEffectiveSettings(options)
	if (shouldSkipProject(resolve(cwd), settings)) return
	withCaveMemDb(options, db => {
		const resolvedCwd = resolve(cwd)
		db.prepare('INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)').run(
			sessionID,
			'opencode',
			resolvedCwd,
			Date.now(),
			null,
		)
	})
	recordCaveMemLifecycleEvent(
		sessionID,
		cwd,
		'session-start',
		`cwd=${sanitizeObservationText(resolve(cwd), settings)}`,
		options,
	)
}

export function endCaveMemSession(sessionID: string, options: CaveMemOptions = {}): void {
	if (!sessionID) return
	let sessionCwd = ''
	withCaveMemDb(options, db => {
		const row = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionID) as { cwd?: string } | undefined
		sessionCwd = typeof row?.cwd === 'string' ? row.cwd : ''
		db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), sessionID)
	})
	recordCaveMemLifecycleEvent(sessionID, sessionCwd, 'session-end', 'status=closed', options)
}

export function recordCaveMemUserPrompt(
	sessionID: string,
	cwd: string,
	prompt: string,
	options: CaveMemOptions = {},
): void {
	if (!prompt.trim()) return
	insertObservation(
		sessionID,
		cwd,
		'user_prompt',
		renderObservationBody({ event: 'user-prompt-submit', content: prompt }, options),
		{ event: 'user-prompt-submit' },
		options,
	)
}

export function recordCaveMemToolUse(
	sessionID: string,
	cwd: string,
	toolName: string,
	toolInput: unknown,
	toolOutput: unknown,
	options: CaveMemOptions = {},
): void {
	const body = renderObservationBody(
		{
			event: 'post-tool-use',
			toolName,
			toolInput,
			toolOutput,
		},
		options,
	)
	if (!body.trim()) return
	insertObservation(sessionID, cwd, 'tool_use', body, { tool: toolName, event: 'post-tool-use' }, options)
}

export function recordCaveMemAssistantStop(
	sessionID: string,
	cwd: string,
	text: string,
	options: CaveMemOptions = {},
): void {
	if (!text.trim()) return
	insertObservation(
		sessionID,
		cwd,
		'assistant_stop',
		renderObservationBody({ event: 'stop', content: text }, options),
		{ event: 'stop' },
		options,
	)
}

export function recordCaveMemSessionSummary(
	sessionID: string,
	cwd: string,
	summary: string,
	options: CaveMemOptions = {},
): void {
	if (!summary.trim()) return
	insertObservation(
		sessionID,
		cwd,
		'session_summary',
		renderObservationBody({ event: 'session-summary', content: summary.slice(0, 4000) }, options),
		{ event: 'session-summary' },
		options,
	)
}

export function mirrorMemoryNoteToCaveMem(
	cwd: string,
	title: string,
	content: string,
	options: CaveMemOptions = {},
): void {
	const resolvedCwd = resolve(cwd)
	const slug = slugify(title)
	const sessionID = getCaveMemProjectSessionID(resolvedCwd)
	insertObservation(
		sessionID,
		resolvedCwd,
		'memory_note',
		renderObservationBody({ event: 'memory-note', title: title.trim(), content: content.trim() }, options),
		{
			title: sanitizeObservationText(title.trim(), getEffectiveSettings(options)),
			slug,
			source: 'opencode-harness-memory',
			event: 'memory-note',
		},
		options,
	)
}

export function recordCaveMemLifecycleEvent(
	sessionID: string,
	cwd: string,
	event: 'session-start' | 'session-end',
	body: string,
	options: CaveMemOptions = {},
): void {
	insertObservation(
		sessionID,
		cwd,
		'lifecycle',
		renderObservationBody({ event, content: body }, options),
		{ event },
		options,
	)
}

export function searchCaveMemProject(
	query: string,
	cwd: string,
	maxResults: number = 5,
	options: CaveMemOptions = {},
): Array<MemoryHeader & { score: number }> {
	if (!query.trim()) return []
	const settings = getEffectiveSettings(options)
	const limit = maxResults > 0 ? maxResults : settings.searchDefaultLimit

	return withCaveMemDb(options, db => {
		const resolvedCwd = resolve(cwd)
		const lexicalRows = db
			.prepare(
				`SELECT o.id, o.session_id, o.kind, o.content, o.intensity, o.ts, o.metadata,
				        snippet(observations_fts, 0, '[', ']', '...', 16) AS snippet,
				        bm25(observations_fts) AS score
				 FROM observations_fts
				 JOIN observations o ON o.id = observations_fts.rowid
				 JOIN sessions s ON s.id = o.session_id
				 WHERE observations_fts MATCH ? AND s.cwd = ?
				 ORDER BY score ASC, o.ts DESC
					 LIMIT ?`,
			)
			.all(sanitizeMatch(query), resolvedCwd, limit * 3) as unknown as CaveMemSearchRow[]
		const semanticRows = loadSemanticCandidates(db, resolvedCwd, limit * 12)
		return buildHybridSearchResults(query, lexicalRows, semanticRows, settings, limit)
	})
}

export function reindexCaveMemProject(cwd: string, options: CaveMemOptions = {}): CaveMemReindexResult {
	const settings = getEffectiveSettings(options)
	const provider = normalizeEmbeddingProvider(settings.embeddingProvider)
	return withCaveMemDb(options, db => {
		const rows = db
			.prepare(
				`SELECT o.id, o.content, o.metadata
				 FROM observations o
				 JOIN sessions s ON s.id = o.session_id
				 WHERE s.cwd = ?`,
			)
			.all(resolve(cwd)) as Array<Record<string, unknown>>
		let updated = 0
		for (const row of rows) {
			const id = Number(row['id'] ?? 0)
			if (!id) continue
			const currentMetadata = parseJsonObject(
				typeof row['metadata'] === 'string' ? (row['metadata'] as string) : null,
			)
			const nextMetadata = applyEmbeddingMetadata(currentMetadata, String(row['content'] ?? ''), settings)
			if (JSON.stringify(currentMetadata) === JSON.stringify(nextMetadata)) continue
			db.prepare('UPDATE observations SET metadata = ? WHERE id = ?').run(JSON.stringify(nextMetadata), id)
			updated++
		}
		return { provider, scanned: rows.length, updated }
	})
}

export function countCaveMemProjectObservations(cwd: string, options: CaveMemOptions = {}): number {
	return withCaveMemDb(options, db => {
		const row = db
			.prepare(
				'SELECT COUNT(*) AS count FROM observations o JOIN sessions s ON s.id = o.session_id WHERE s.cwd = ?',
			)
			.get(resolve(cwd)) as { count: number }
		return row.count
	})
}

export function listCaveMemSessions(
	cwd: string,
	maxResults: number = 10,
	options: CaveMemOptions = {},
): CaveMemSessionInfo[] {
	const settings = getEffectiveSettings(options)
	const limit = maxResults > 0 ? maxResults : settings.searchDefaultLimit
	return withCaveMemDb(options, db => {
		const rows = db
			.prepare(
				`SELECT s.id AS session_id, s.cwd, s.started_at, s.ended_at,
				        COUNT(o.id) AS observation_count,
				        COALESCE(MAX(o.ts), s.started_at) AS last_event_at
				 FROM sessions s
				 LEFT JOIN observations o ON o.session_id = s.id
				 WHERE s.cwd = ?
				 GROUP BY s.id, s.cwd, s.started_at, s.ended_at
				 ORDER BY last_event_at DESC
				 LIMIT ?`,
			)
			.all(resolve(cwd), limit) as Array<Record<string, unknown>>

		return rows.map(row => ({
			sessionID: String(row['session_id'] ?? ''),
			cwd: String(row['cwd'] ?? ''),
			startedAt: Number(row['started_at'] ?? 0),
			endedAt: row['ended_at'] == null ? null : Number(row['ended_at']),
			observationCount: Number(row['observation_count'] ?? 0),
			lastEventAt: Number(row['last_event_at'] ?? 0),
		}))
	})
}

export function getCaveMemTimeline(
	cwd: string,
	maxResults: number = 10,
	options: CaveMemOptions = {},
): CaveMemObservation[] {
	const settings = getEffectiveSettings(options)
	const limit = maxResults > 0 ? maxResults : settings.searchDefaultLimit
	return withCaveMemDb(options, db => {
		const rows = db
			.prepare(
				`SELECT o.id, o.session_id, o.kind, o.content, o.intensity, o.ts, o.metadata
				 FROM observations o
				 JOIN sessions s ON s.id = o.session_id
				 WHERE s.cwd = ?
				 ORDER BY o.ts DESC
				 LIMIT ?`,
			)
			.all(resolve(cwd), limit) as Array<Record<string, unknown>>
		return rows.map(mapObservationRow)
	})
}

export function getCaveMemObservations(input: {
	sessionID: string
	cwd?: string
	kind?: string
	maxResults?: number
	options?: CaveMemOptions
}): CaveMemObservation[] {
	const options = input.options ?? {}
	const settings = getEffectiveSettings(options)
	const limit = (input.maxResults ?? 0) > 0 ? (input.maxResults as number) : settings.searchDefaultLimit
	return withCaveMemDb(options, db => {
		const filters = ['o.session_id = ?']
		const params: unknown[] = [input.sessionID]
		if (input.cwd) {
			filters.push('s.cwd = ?')
			params.push(resolve(input.cwd))
		}
		if (input.kind?.trim()) {
			filters.push('o.kind = ?')
			params.push(input.kind.trim())
		}
		params.push(limit)

		const rows = db
			.prepare(
				`SELECT o.id, o.session_id, o.kind, o.content, o.intensity, o.ts, o.metadata
				 FROM observations o
				 JOIN sessions s ON s.id = o.session_id
				 WHERE ${filters.join(' AND ')}
				 ORDER BY o.ts DESC
				 LIMIT ?`,
			)
			.all(...params) as Array<Record<string, unknown>>
		return rows.map(mapObservationRow)
	})
}

function insertObservation(
	sessionID: string,
	cwd: string,
	kind: string,
	content: string,
	metadata: Record<string, unknown> | undefined,
	options: CaveMemOptions,
): void {
	if (!sessionID || !content.trim()) return
	const settings = getEffectiveSettings(options)
	withCaveMemDb(options, db => {
		const existingSession = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(sessionID) as
			| { cwd?: string }
			| undefined
		const resolvedCwd = cwd.trim()
			? resolve(cwd)
			: typeof existingSession?.cwd === 'string' && existingSession.cwd.trim()
				? existingSession.cwd
				: resolve('.')
		if (shouldSkipProject(resolvedCwd, settings)) return
		const sanitizedContent = sanitizeObservationText(content, settings)
		if (!sanitizedContent.trim()) return
		const sanitizedMetadata = applyEmbeddingMetadata(
			sanitizeObservationMetadata(metadata, settings),
			sanitizedContent,
			settings,
		)
		db.prepare('INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)').run(
			sessionID,
			'opencode',
			resolvedCwd,
			Date.now(),
			null,
		)
		const mode = options.mode ?? settings.compressionIntensity ?? 'full'
		const compressed = compressForCaveman(sanitizedContent, mode)
		db.prepare(
			'INSERT INTO observations(session_id, kind, content, compressed, intensity, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
		).run(
			sessionID,
			kind,
			compressed,
			1,
			mode,
			Date.now(),
			sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
		)
	})
}

function withCaveMemDb<T>(options: CaveMemOptions, fn: (db: SqliteDatabase) => T): T {
	const dbPath = getCaveMemDbPath(options.dataDir)
	mkdirSync(dirname(dbPath), { recursive: true })
	const db = SQLITE.open(dbPath)
	try {
		db.exec(SCHEMA_SQL)
		return fn(db)
	} finally {
		db.close()
	}
}

async function loadSqliteAdapter(): Promise<SqliteAdapter> {
	try {
		const mod = await import('node:sqlite')
		const DatabaseSync = mod.DatabaseSync
		return {
			open(path: string): SqliteDatabase {
				const db = new DatabaseSync(path)
				return {
					exec(sql) {
						db.exec(sql)
					},
					prepare(sql) {
						const statement = db.prepare(sql)
						return {
							run(...params) {
								return statement.run(...(params as any[]))
							},
							get(...params) {
								return (
									(statement.get(...(params as any[])) as Record<string, unknown> | undefined) ??
									undefined
								)
							},
							all(...params) {
								return statement.all(...(params as any[])) as Record<string, unknown>[]
							},
						}
					},
					close() {
						db.close()
					},
				}
			},
		}
	} catch {
		const mod = await import('bun:sqlite')
		const Database = mod.Database
		return {
			open(path: string): SqliteDatabase {
				const db = new Database(path)
				return {
					exec(sql) {
						db.run(sql)
					},
					prepare(sql) {
						const query = db.query(sql)
						return {
							run(...params) {
								return query.run(...(params as any[]))
							},
							get(...params) {
								return (
									(query.get(...(params as any[])) as Record<string, unknown> | undefined) ??
									undefined
								)
							},
							all(...params) {
								return query.all(...(params as any[])) as Record<string, unknown>[]
							},
						}
					},
					close() {
						db.close()
					},
				}
			},
		}
	}
}

function getCaveMemDbPath(explicitDataDir?: string): string {
	return join(resolveCaveMemDataDir(explicitDataDir), 'data.db')
}

function resolveCaveMemDataDir(explicitDataDir?: string): string {
	if (explicitDataDir?.trim()) return resolvePath(explicitDataDir)
	const settings = resolveCaveMemSettings()
	if (settings.dataDir?.trim()) return resolvePath(settings.dataDir)

	const settingsPath = join(homedir(), '.cavemem', 'settings.json')
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
			if (typeof parsed['dataDir'] === 'string' && parsed['dataDir'].trim()) {
				return resolvePath(parsed['dataDir'])
			}
		} catch {
			// ignore malformed settings and fall back to default data dir
		}
	}

	return join(homedir(), '.cavemem')
}

function resolvePath(path: string): string {
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return join(homedir(), path.slice(2))
	return resolve(path)
}

function sanitizeMatch(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.map(token => `"${token.replace(/"/g, '""')}"`)
		.join(' ')
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function formatKindTitle(kind: string, id: number, metadata: Record<string, unknown>): string {
	const event = typeof metadata['event'] === 'string' ? metadata['event'] : ''
	if (kind === 'memory_note') return `Memory Note ${id}`
	if (kind === 'user_prompt') return `User Prompt ${id}`
	if (kind === 'tool_use') return `Tool Use ${id}`
	if (kind === 'assistant_stop') return `Stop ${id}`
	if (kind === 'session_summary') return `Session Summary ${id}`
	if (kind === 'lifecycle' && event) return `${titleCase(event)} ${id}`
	return `${kind} ${id}`
}

function getCaveMemProjectSessionID(cwd: string): string {
	return `opencode-harness-memory-${sha1(resolve(cwd)).slice(0, 16)}`
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

function sha1(input: string): string {
	return createHash('sha1').update(input).digest('hex')
}

function stringifyShort(value: unknown): string {
	if (value == null) return ''
	if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value
	if (
		typeof value === 'object' &&
		value &&
		'output' in value &&
		typeof (value as Record<string, unknown>)['output'] === 'string'
	) {
		const text = String((value as Record<string, unknown>)['output'])
		return text.length > 500 ? `${text.slice(0, 500)}...` : text
	}
	try {
		const serialized = JSON.stringify(value)
		return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized
	} catch {
		return String(value)
	}
}

function getEffectiveSettings(options: CaveMemOptions): ResolvedCaveMemSettings {
	const resolved = resolveCaveMemSettings()
	return {
		...resolved,
		dataDir: options.dataDir ?? resolved.dataDir,
		compressionIntensity: options.mode ?? resolved.compressionIntensity,
		expandForModel: options.expandForModel ?? resolved.expandForModel,
		embeddingProvider: options.embeddingProvider ?? resolved.embeddingProvider,
		searchAlpha: options.searchAlpha ?? resolved.searchAlpha,
		searchDefaultLimit: options.searchDefaultLimit ?? resolved.searchDefaultLimit,
		redactPrivateTags: options.redactPrivateTags ?? resolved.redactPrivateTags,
		excludePathPatterns:
			options.excludePathPatterns && options.excludePathPatterns.length > 0
				? uniqueStrings([...resolved.excludePathPatterns, ...options.excludePathPatterns])
				: resolved.excludePathPatterns,
	}
}

function shouldSkipProject(cwd: string, settings: ResolvedCaveMemSettings): boolean {
	return matchesExcludedPattern(cwd, settings.excludePathPatterns)
}

function sanitizeObservationText(input: string, settings: ResolvedCaveMemSettings): string {
	let text = input
	if (settings.redactPrivateTags) {
		text = text.replace(/<private>[\s\S]*?<\/private>/gi, '[private]')
	}
	for (const token of extractPathTokens(text)) {
		if (!matchesExcludedPattern(token, settings.excludePathPatterns)) continue
		text = text.replaceAll(token, '[excluded-path]')
	}
	for (const pattern of settings.excludePathPatterns) {
		if (/[/*?\\]/.test(pattern)) continue
		const escaped = escapeRegex(pattern)
		text = text.replace(
			new RegExp(`(^|[^A-Za-z0-9_.-])(${escaped})(?=$|[^A-Za-z0-9_.-])`, 'gi'),
			`$1[excluded-path]`,
		)
	}
	return text.trim()
}

function sanitizeObservationMetadata(
	metadata: Record<string, unknown> | undefined,
	settings: ResolvedCaveMemSettings,
): Record<string, unknown> | undefined {
	if (!metadata) return metadata
	const sanitized: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof value === 'string') {
			sanitized[key] = sanitizeObservationText(value, settings)
			continue
		}
		sanitized[key] = value
	}
	return sanitized
}

function applyEmbeddingMetadata(
	metadata: Record<string, unknown> | undefined,
	content: string,
	settings: ResolvedCaveMemSettings,
): Record<string, unknown> {
	const next = { ...(metadata ?? {}) }
	const provider = normalizeEmbeddingProvider(settings.embeddingProvider)
	if (provider === 'none') {
		delete next['embeddingProvider']
		delete next['embeddingVector']
		return next
	}
	const vector = createEmbeddingVector(content, provider)
	if (!vector) {
		delete next['embeddingProvider']
		delete next['embeddingVector']
		return next
	}
	next['embeddingProvider'] = provider
	next['embeddingVector'] = vector
	return next
}

function renderObservationBody(
	input: {
		event: string
		content?: string
		title?: string
		toolName?: string
		toolInput?: unknown
		toolOutput?: unknown
	},
	options: CaveMemOptions,
): string {
	if (input.event === 'post-tool-use') {
		return [
			`[post-tool-use] tool=${input.toolName ?? 'unknown'}`,
			`input=${stringifyShort(input.toolInput)}`,
			`output=${stringifyShort(input.toolOutput)}`,
		]
			.join('\n')
			.slice(0, 4000)
	}
	if (input.event === 'memory-note') {
		return [`[memory-note] title=${input.title ?? 'note'}`, '', input.content ?? ''].join('\n').slice(0, 4000)
	}
	return [`[${input.event}]`, input.content ?? ''].join('\n').trim().slice(0, 4000)
}

function extractPathTokens(input: string): string[] {
	return uniqueStrings(
		Array.from(
			input.matchAll(/(?:\.{1,2}\/|\/|(?:[A-Za-z0-9_.-]+\/)+)[A-Za-z0-9_.\-/]+(?:\.[A-Za-z0-9_.-]+)?/g),
			match => match[0],
		),
	)
}

function matchesExcludedPattern(path: string, patterns: string[]): boolean {
	if (!path || patterns.length === 0) return false
	const normalizedPath = normalizePathLike(path)
	return patterns.some(pattern => {
		const normalizedPattern = normalizePathLike(pattern)
		if (!normalizedPattern) return false
		if (!/[*?]/.test(normalizedPattern)) {
			return (
				normalizedPath === normalizedPattern ||
				normalizedPath.endsWith(`/${normalizedPattern}`) ||
				normalizedPath.includes(normalizedPattern)
			)
		}
		return globPatternToRegex(normalizedPattern).test(normalizedPath)
	})
}

function globPatternToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	const regex = escaped
		.replace(/\*\*/g, '::DOUBLE_STAR::')
		.replace(/\*/g, '[^/]*')
		.replace(/::DOUBLE_STAR::/g, '.*')
	return new RegExp(`^${regex}$`, 'i')
}

function normalizePathLike(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase()
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>()
	const ordered: string[] = []
	for (const value of values) {
		const trimmed = value.trim()
		if (!trimmed) continue
		if (seen.has(trimmed)) continue
		seen.add(trimmed)
		ordered.push(trimmed)
	}
	return ordered
}

function titleCase(value: string): string {
	return value
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(part => part[0]!.toUpperCase() + part.slice(1))
		.join(' ')
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mapObservationRow(row: Record<string, unknown>): CaveMemObservation {
	const metadata = parseJsonObject(typeof row['metadata'] === 'string' ? (row['metadata'] as string) : null)
	return {
		id: Number(row['id'] ?? 0),
		sessionID: String(row['session_id'] ?? ''),
		kind: String(row['kind'] ?? ''),
		event: typeof metadata['event'] === 'string' ? metadata['event'] : String(row['kind'] ?? ''),
		content: String(row['content'] ?? ''),
		timestamp: Number(row['ts'] ?? 0),
		intensity: row['intensity'] == null ? null : String(row['intensity']),
		metadata,
	}
}

function loadSemanticCandidates(db: SqliteDatabase, cwd: string, limit: number): CaveMemSearchRow[] {
	return db
		.prepare(
			`SELECT o.id, o.session_id, o.kind, o.content, o.intensity, o.ts, o.metadata,
			        '' AS snippet,
			        0 AS score
			 FROM observations o
			 JOIN sessions s ON s.id = o.session_id
			 WHERE s.cwd = ?
			 ORDER BY o.ts DESC
			 LIMIT ?`,
		)
		.all(cwd, Math.min(Math.max(limit, 25), 200)) as unknown as CaveMemSearchRow[]
}

function buildHybridSearchResults(
	query: string,
	lexicalRows: CaveMemSearchRow[],
	semanticRows: CaveMemSearchRow[],
	settings: ResolvedCaveMemSettings,
	limit: number,
): Array<MemoryHeader & { score: number }> {
	const provider = normalizeEmbeddingProvider(settings.embeddingProvider)
	const semanticWeight = provider === 'none' ? 0 : settings.searchAlpha
	const lexicalWeight = provider === 'none' ? 1 : 1 - semanticWeight
	const queryVector = createEmbeddingVector(query, provider)
	const lexicalScores = new Map<string, number>()
	const semanticScores = new Map<string, number>()
	const rowsByUri = new Map<string, CaveMemSearchRow>()

	lexicalRows.forEach((row, index) => {
		const uri = `cavemem://${row.session_id}/${row.id}`
		rowsByUri.set(uri, row)
		lexicalScores.set(uri, normalizeRankScore(index, lexicalRows.length))
	})

	for (const row of semanticRows) {
		const uri = `cavemem://${row.session_id}/${row.id}`
		if (!rowsByUri.has(uri)) rowsByUri.set(uri, row)
		if (!queryVector) continue
		const metadata = parseJsonObject(row.metadata)
		const rowVector = readEmbeddingVector(metadata, provider) ?? createEmbeddingVector(row.content, provider)
		const score = cosineSimilarity(queryVector, rowVector)
		if (score > 0) semanticScores.set(uri, score)
	}

	const results: Array<MemoryHeader & { score: number }> = []
	for (const [uri, row] of rowsByUri.entries()) {
		const metadata = parseJsonObject(row.metadata)
		const lexical = lexicalScores.get(uri) ?? 0
		const semantic = semanticScores.get(uri) ?? 0
		const blended = lexical * lexicalWeight + semantic * semanticWeight
		if (blended <= 0) continue
		const title =
			typeof metadata['title'] === 'string' && metadata['title'].trim()
				? metadata['title'].trim()
				: formatKindTitle(row.kind, row.id, metadata)
		const snippet = row.snippet.trim() || row.content.replace(/\s+/g, ' ').trim().slice(0, 200)
		results.push({
			path: uri,
			title,
			description: snippet.slice(0, 200),
			memoryType: `cavemem:${row.kind}`,
			bodyPreview: row.content.replace(/\s+/g, ' ').trim().slice(0, 300),
			modifiedAt: row.ts,
			score: Number(blended.toFixed(6)),
		})
	}

	return results.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt).slice(0, limit)
}

function readEmbeddingVector(metadata: Record<string, unknown>, provider: string): number[] | null {
	if (metadata['embeddingProvider'] !== provider) return null
	const raw = metadata['embeddingVector']
	if (!Array.isArray(raw)) return null
	const vector = raw.map(value => (typeof value === 'number' ? value : Number.NaN))
	return vector.every(value => Number.isFinite(value)) ? (vector as number[]) : null
}

function normalizeRankScore(index: number, length: number): number {
	if (length <= 0) return 0
	return (length - index) / length
}
