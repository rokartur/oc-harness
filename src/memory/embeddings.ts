export type CaveMemEmbeddingProvider = 'none' | 'local-hash'

const LOCAL_HASH_DIMENSIONS = 64
const TOKEN_ALIAS: Record<string, string> = {
	authentication: 'auth',
	authorization: 'auth',
	authz: 'auth',
	renew: 'refresh',
	renewal: 'refresh',
	rotate: 'refresh',
	rotation: 'refresh',
	credential: 'token',
	credentials: 'token',
	session: 'token',
	sessions: 'token',
	guardrail: 'invariant',
	guardrails: 'invariant',
	failure: 'fail',
	failures: 'fail',
	error: 'fail',
	errors: 'fail',
	middleware: 'middleware',
}

export function normalizeEmbeddingProvider(value: string | undefined): CaveMemEmbeddingProvider {
	return value === 'local-hash' ? 'local-hash' : 'none'
}

export function createEmbeddingVector(text: string, provider: string | undefined): number[] | null {
	const normalized = normalizeEmbeddingProvider(provider)
	if (normalized === 'none') return null
	return createLocalHashVector(text)
}

export function cosineSimilarity(left: number[] | null, right: number[] | null): number {
	if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) return 0
	let dot = 0
	let leftNorm = 0
	let rightNorm = 0
	for (let index = 0; index < left.length; index++) {
		const a = left[index] ?? 0
		const b = right[index] ?? 0
		dot += a * b
		leftNorm += a * a
		rightNorm += b * b
	}
	if (leftNorm === 0 || rightNorm === 0) return 0
	return dot / Math.sqrt(leftNorm * rightNorm)
}

function createLocalHashVector(text: string): number[] | null {
	const tokens = tokenizeForEmbedding(text)
	if (tokens.length === 0) return null
	const vector = new Array<number>(LOCAL_HASH_DIMENSIONS).fill(0)
	for (const token of tokens) {
		const primary = hashToken(token)
		const secondary = hashToken(`${token}!`)
		vector[primary % LOCAL_HASH_DIMENSIONS] += 1
		vector[secondary % LOCAL_HASH_DIMENSIONS] += token.length > 6 ? 0.5 : 0.25
	}
	return normalizeVector(vector)
}

function tokenizeForEmbedding(text: string): string[] {
	const rawTokens = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
		.map(normalizeToken)
		.filter(token => token.length >= 2)
	if (rawTokens.length === 0) return []
	const expanded = [...rawTokens]
	for (let index = 0; index < rawTokens.length - 1; index++) {
		expanded.push(`${rawTokens[index]}_${rawTokens[index + 1]}`)
	}
	return expanded
}

function normalizeToken(token: string): string {
	return TOKEN_ALIAS[token] ?? token
}

function normalizeVector(vector: number[]): number[] {
	let norm = 0
	for (const value of vector) norm += value * value
	if (norm === 0) return vector
	const scale = Math.sqrt(norm)
	return vector.map(value => Number((value / scale).toFixed(6)))
}

function hashToken(token: string): number {
	let hash = 2166136261
	for (let index = 0; index < token.length; index++) {
		hash ^= token.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}
