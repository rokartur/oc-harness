import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MemoryHeader } from './scan.js'
import type { CaveMemObservation, CaveMemReindexResult, CaveMemSessionInfo } from './cavemem.js'

interface JsonRpcResponse {
	jsonrpc?: string
	id?: number
	result?: unknown
	error?: { code?: number; message?: string; data?: unknown }
	method?: string
	params?: unknown
}

interface McpToolCallResult {
	content?: Array<{ type?: string; text?: string }>
	structuredContent?: unknown
	[key: string]: unknown
}

interface CavememMcpClientOptions {
	binary: string
	dataDir?: string
	timeoutMs?: number
}

interface SearchInput {
	query: string
	cwd: string
	limit: number
}

interface TimelineInput {
	query: string
	cwd: string
	limit: number
}

interface ObservationsInput {
	ids: number[]
	cwd: string
}

interface SessionsInput {
	cwd: string
	limit: number
}

interface ReindexInput {
	cwd: string
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function searchCaveMemProjectViaMcp(
	input: SearchInput,
	options: CavememMcpClientOptions,
): Promise<Array<MemoryHeader & { score: number }> | null> {
	const result = await callCavememTool(
		'search',
		{ query: input.query, limit: input.limit, project: input.cwd },
		options,
	)
	if (!result) return null
	const payload = normalizeStructuredPayload(result)
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as Record<string, unknown>)?.['results'])
			? ((payload as Record<string, unknown>)['results'] as unknown[])
			: []
	return rows
		.map((row, index) => mapSearchRow(row, index))
		.filter((row): row is MemoryHeader & { score: number } => row != null)
}

export async function getCaveMemTimelineViaMcp(
	input: TimelineInput,
	options: CavememMcpClientOptions,
): Promise<CaveMemObservation[] | null> {
	const result = await callCavememTool(
		'timeline',
		{ query: input.query, depth_before: Math.max(0, input.limit - 1), depth_after: 0, project: input.cwd },
		options,
	)
	if (!result) return null
	const payload = normalizeStructuredPayload(result)
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as Record<string, unknown>)?.['results'])
			? ((payload as Record<string, unknown>)['results'] as unknown[])
			: []
	return rows.map(mapObservation).filter((row): row is CaveMemObservation => row != null)
}

export async function getCaveMemObservationsByIdsViaMcp(
	input: ObservationsInput,
	options: CavememMcpClientOptions,
): Promise<CaveMemObservation[] | null> {
	const result = await callCavememTool('get_observations', { ids: input.ids }, options)
	if (!result) return null
	const payload = normalizeStructuredPayload(result)
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as Record<string, unknown>)?.['results'])
			? ((payload as Record<string, unknown>)['results'] as unknown[])
			: []
	return rows.map(mapObservation).filter((row): row is CaveMemObservation => row != null)
}

export async function hydrateCaveMemSearchResultsViaMcp(
	results: Array<MemoryHeader & { score: number }>,
	input: ObservationsInput,
	options: CavememMcpClientOptions,
	maxResults: number = 3,
): Promise<Array<MemoryHeader & { score: number }> | null> {
	const ids = uniqueNumbers(
		results
			.slice(0, Math.max(0, maxResults))
			.map(result => parseObservationID(result.path))
			.filter((value): value is number => value != null),
	)
	if (ids.length === 0) return results
	const observations = await getCaveMemObservationsByIdsViaMcp({ ...input, ids }, options)
	if (!observations || observations.length === 0) return results
	const byId = new Map(observations.map(observation => [observation.id, observation]))
	return results.map(result => {
		const id = parseObservationID(result.path)
		if (!id) return result
		const observation = byId.get(id)
		if (!observation) return result
		const content = observation.content.replace(/\s+/g, ' ').trim()
		return {
			...result,
			description: content.slice(0, 200) || result.description,
			bodyPreview: content.slice(0, 500) || result.bodyPreview,
			modifiedAt: observation.timestamp || result.modifiedAt,
		}
	})
}

export async function listCaveMemSessionsViaMcp(
	input: SessionsInput,
	options: CavememMcpClientOptions,
): Promise<CaveMemSessionInfo[] | null> {
	const result = await callCavememTool('list_sessions', { limit: input.limit, project: input.cwd }, options)
	if (!result) return null
	const payload = normalizeStructuredPayload(result)
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray((payload as Record<string, unknown>)?.['results'])
			? ((payload as Record<string, unknown>)['results'] as unknown[])
			: []
	return rows.map(mapSession).filter((row): row is CaveMemSessionInfo => row != null)
}

export async function reindexCaveMemProjectViaMcp(
	input: ReindexInput,
	options: CavememMcpClientOptions,
): Promise<CaveMemReindexResult | null> {
	const result = await callCavememTool('reindex', { project: input.cwd }, options)
	if (!result) return null
	const payload = normalizeStructuredPayload(result)
	const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
	if (!record) return null
	return {
		provider: typeof record['provider'] === 'string' ? record['provider'] : 'unknown',
		scanned: Number(record['scanned'] ?? 0),
		updated: Number(record['updated'] ?? 0),
	}
}

async function callCavememTool(
	canonicalName: 'search' | 'timeline' | 'get_observations' | 'list_sessions' | 'reindex',
	argumentsPayload: Record<string, unknown>,
	options: CavememMcpClientOptions,
): Promise<McpToolCallResult | null> {
	const client = new StdioMcpClient(options)
	try {
		await client.initialize()
		const tools = await client.listTools()
		const toolName = resolveToolName(canonicalName, tools)
		if (!toolName) return null
		const result = await client.callTool(toolName, argumentsPayload)
		return result
	} catch {
		return null
	} finally {
		await client.close()
	}
}

function resolveToolName(canonicalName: string, tools: string[]): string | null {
	const candidateMap: Record<string, string[]> = {
		search: ['search', 'cavemem_search'],
		timeline: ['timeline', 'cavemem_timeline'],
		get_observations: ['get_observations', 'cavemem_get_observations'],
		list_sessions: ['list_sessions', 'cavemem_list_sessions'],
		reindex: ['reindex', 'cavemem_reindex'],
	}
	const candidates = candidateMap[canonicalName] ?? []
	for (const candidate of candidates) {
		if (tools.includes(candidate)) return candidate
	}
	return null
}

function normalizeStructuredPayload(result: McpToolCallResult): unknown {
	if (result.structuredContent != null) return result.structuredContent
	const text = result.content
		?.filter(entry => entry.type === 'text' && typeof entry.text === 'string')
		.map(entry => entry.text)
		.join('\n')
		.trim()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return { text }
	}
}

function mapSearchRow(row: unknown, index: number): (MemoryHeader & { score: number }) | null {
	if (!row || typeof row !== 'object') return null
	const record = row as Record<string, unknown>
	const path = stringField(record, ['path', 'uri', 'ref'])
	if (!path) return null
	return {
		path,
		title: stringField(record, ['title', 'name']) || `Observation ${index + 1}`,
		description: stringField(record, ['description', 'snippet', 'summary']) || '',
		memoryType: stringField(record, ['memoryType', 'type']) || 'cavemem:observation',
		bodyPreview:
			stringField(record, ['bodyPreview', 'content', 'text']) || stringField(record, ['description']) || '',
		modifiedAt: numberField(record, ['modifiedAt', 'timestamp', 'ts']) || 0,
		score: numberField(record, ['score']) || normalizeSearchScore(index),
	}
}

function mapObservation(row: unknown): CaveMemObservation | null {
	if (!row || typeof row !== 'object') return null
	const record = row as Record<string, unknown>
	const sessionID = stringField(record, ['sessionID', 'session_id'])
	const id = numberField(record, ['id'])
	if (!sessionID || !id) return null
	return {
		id,
		sessionID,
		kind: stringField(record, ['kind']) || 'observation',
		event: stringField(record, ['event', 'kind']) || 'observation',
		content: stringField(record, ['content', 'text', 'body']) || '',
		timestamp: numberField(record, ['timestamp', 'ts']) || 0,
		intensity: stringField(record, ['intensity']) || null,
		metadata: (record['metadata'] as Record<string, unknown>) ?? {},
	}
}

function mapSession(row: unknown): CaveMemSessionInfo | null {
	if (!row || typeof row !== 'object') return null
	const record = row as Record<string, unknown>
	const sessionID = stringField(record, ['sessionID', 'session_id'])
	if (!sessionID) return null
	return {
		sessionID,
		cwd: stringField(record, ['cwd', 'project']) || '',
		startedAt: numberField(record, ['startedAt', 'started_at']) || 0,
		endedAt: nullableNumberField(record, ['endedAt', 'ended_at']),
		observationCount: numberField(record, ['observationCount', 'observation_count']) || 0,
		lastEventAt: numberField(record, ['lastEventAt', 'last_event_at']) || 0,
	}
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		if (typeof record[key] === 'string' && record[key]) return record[key] as string
	}
	return ''
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === 'number' && Number.isFinite(value)) return value
	}
	return null
}

function nullableNumberField(record: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = record[key]
		if (value == null) return null
		if (typeof value === 'number' && Number.isFinite(value)) return value
	}
	return null
}

function normalizeSearchScore(index: number): number {
	return Number((1 / (index + 1)).toFixed(6))
}

function parseObservationID(uri: string): number | null {
	const match = uri.match(/^cavemem:\/\/[^/]+\/(\d+)$/)
	if (!match) return null
	const value = Number.parseInt(match[1] ?? '', 10)
	return Number.isFinite(value) ? value : null
}

function uniqueNumbers(values: number[]): number[] {
	const seen = new Set<number>()
	const ordered: number[] = []
	for (const value of values) {
		if (!Number.isFinite(value) || seen.has(value)) continue
		seen.add(value)
		ordered.push(value)
	}
	return ordered
}

class StdioMcpClient {
	private child: ChildProcessWithoutNullStreams | null = null
	private nextID = 1
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	private stdoutBuffer = Buffer.alloc(0)
	private stderrChunks: string[] = []
	private initialized = false
	private timeoutMs: number

	constructor(private options: CavememMcpClientOptions) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		this.child = spawn(this.options.binary, ['mcp'], {
			env: {
				...process.env,
				...(this.options.dataDir ? { CAVEMEM_DATA_DIR: this.options.dataDir } : {}),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		this.child.stdout.on('data', chunk => this.handleStdout(chunk))
		this.child.stderr.on('data', chunk => this.stderrChunks.push(String(chunk)))
		this.child.on('exit', code => {
			for (const { reject } of this.pending.values()) {
				reject(new Error(`cavemem mcp exited with code ${code}: ${this.stderrChunks.join('')}`.trim()))
			}
			this.pending.clear()
		})
		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'opencode-harness', version: '0.1.0' },
		})
		this.notify('notifications/initialized', {})
		this.initialized = true
	}

	async listTools(): Promise<string[]> {
		const response = (await this.request('tools/list', {})) as { tools?: Array<{ name?: string }> }
		return Array.isArray(response?.tools)
			? response.tools.map(tool => tool?.name).filter((name): name is string => typeof name === 'string')
			: []
	}

	async callTool(name: string, argumentsPayload: Record<string, unknown>): Promise<McpToolCallResult> {
		return (await this.request('tools/call', { name, arguments: argumentsPayload })) as McpToolCallResult
	}

	async close(): Promise<void> {
		if (!this.child) return
		this.child.kill()
		this.child = null
		this.initialized = false
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (!this.child) return Promise.reject(new Error('MCP client not started'))
		const id = this.nextID++
		const payload = { jsonrpc: '2.0', id, method, params }
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`Timed out calling cavemem mcp method '${method}'`))
			}, this.timeoutMs)
			this.pending.set(id, {
				resolve: value => {
					clearTimeout(timer)
					resolve(value)
				},
				reject: error => {
					clearTimeout(timer)
					reject(error)
				},
			})
			this.writeMessage(payload)
		})
	}

	private notify(method: string, params: unknown): void {
		if (!this.child) return
		this.writeMessage({ jsonrpc: '2.0', method, params })
	}

	private writeMessage(payload: Record<string, unknown>): void {
		if (!this.child) return
		const body = JSON.stringify(payload)
		const message = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
		this.child.stdin.write(message)
	}

	private handleStdout(chunk: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
		while (true) {
			const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n')
			if (headerEnd === -1) return
			const header = this.stdoutBuffer.slice(0, headerEnd).toString('utf8')
			const lengthMatch = header.match(/Content-Length:\s*(\d+)/i)
			if (!lengthMatch) {
				this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4)
				continue
			}
			const length = Number.parseInt(lengthMatch[1] ?? '0', 10)
			const bodyStart = headerEnd + 4
			const bodyEnd = bodyStart + length
			if (this.stdoutBuffer.length < bodyEnd) return
			const body = this.stdoutBuffer.slice(bodyStart, bodyEnd).toString('utf8')
			this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd)
			let message: JsonRpcResponse | null = null
			try {
				message = JSON.parse(body) as JsonRpcResponse
			} catch {
				continue
			}
			if (typeof message.id !== 'number') continue
			const pending = this.pending.get(message.id)
			if (!pending) continue
			this.pending.delete(message.id)
			if (message.error) {
				pending.reject(new Error(message.error.message ?? 'Unknown MCP error'))
				continue
			}
			pending.resolve(message.result)
		}
	}
}
