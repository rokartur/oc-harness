import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import {
	getCaveMemObservations,
	getCaveMemTimeline,
	listCaveMemSessions,
	reindexCaveMemProject,
	searchCaveMemProject,
} from './cavemem.js'

const z = tool.schema

export interface CaveMemInspectToolOptions {
	dataDir?: string
	defaultLimit?: number
	searchAlpha?: number
	embeddingProvider?: string
}

export function createCaveMemInspectTools(options: CaveMemInspectToolOptions = {}): Record<string, ToolDefinition> {
	const defaultLimit = options.defaultLimit ?? 5
	return {
		cavemem_search: tool({
			description: 'Fallback CaveMem search tool when native cavemem MCP is unavailable.',
			args: {
				query: z.string().describe('Search query'),
				limit: z.number().optional().describe('Optional result limit'),
			},
			async execute(args, ctx) {
				const results = searchCaveMemProject(args.query, ctx.directory, args.limit ?? defaultLimit, {
					dataDir: options.dataDir,
					searchAlpha: options.searchAlpha,
					embeddingProvider: options.embeddingProvider,
					searchDefaultLimit: defaultLimit,
				})
				if (results.length === 0) return 'No CaveMem results.'
				return results
					.map(result => `## ${result.title}\n${result.description}\nref=${result.path}`)
					.join('\n\n')
			},
		}),
		cavemem_timeline: tool({
			description: 'Fallback CaveMem timeline for the current project or session.',
			args: {
				limit: z.number().optional().describe('Optional result limit'),
				sessionID: z.string().optional().describe('Optional session id filter'),
			},
			async execute(args, ctx) {
				const entries = args.sessionID
					? getCaveMemObservations({
							sessionID: args.sessionID,
							cwd: ctx.directory,
							maxResults: args.limit ?? defaultLimit,
							options: { dataDir: options.dataDir, searchDefaultLimit: defaultLimit },
						})
					: getCaveMemTimeline(ctx.directory, args.limit ?? defaultLimit, {
							dataDir: options.dataDir,
							searchDefaultLimit: defaultLimit,
						})
				if (entries.length === 0) return 'No CaveMem timeline entries.'
				return entries.map(formatObservationLine).join('\n')
			},
		}),
		cavemem_get_observations: tool({
			description: 'Fallback CaveMem observation reader for a session.',
			args: {
				sessionID: z.string().optional().describe('Session id; defaults to current session'),
				kind: z.string().optional().describe('Optional observation kind filter'),
				limit: z.number().optional().describe('Optional result limit'),
			},
			async execute(args, ctx) {
				const sessionID = args.sessionID ?? ctx.sessionID
				if (!sessionID) return 'sessionID required.'
				const entries = getCaveMemObservations({
					sessionID,
					cwd: ctx.directory,
					kind: args.kind,
					maxResults: args.limit ?? defaultLimit,
					options: { dataDir: options.dataDir, searchDefaultLimit: defaultLimit },
				})
				if (entries.length === 0) return 'No CaveMem observations.'
				return entries
					.map(
						entry =>
							`## ${entry.event} ${entry.id}\nts=${new Date(entry.timestamp).toISOString()}\n${entry.content}`,
					)
					.join('\n\n')
			},
		}),
		cavemem_list_sessions: tool({
			description: 'Fallback CaveMem session lister for the current project.',
			args: {
				limit: z.number().optional().describe('Optional result limit'),
			},
			async execute(args, ctx) {
				const sessions = listCaveMemSessions(ctx.directory, args.limit ?? defaultLimit, {
					dataDir: options.dataDir,
					searchDefaultLimit: defaultLimit,
				})
				if (sessions.length === 0) return 'No CaveMem sessions.'
				return sessions
					.map(session => {
						const ended = session.endedAt ? new Date(session.endedAt).toISOString() : 'open'
						return `- ${session.sessionID} obs=${session.observationCount} started=${new Date(session.startedAt).toISOString()} ended=${ended}`
					})
					.join('\n')
			},
		}),
		cavemem_reindex: tool({
			description: 'Rebuild local CaveMem embedding metadata for the current project.',
			args: {
				provider: z.string().optional().describe('Optional embedding provider override, e.g. local-hash'),
			},
			async execute(args, ctx) {
				const result = reindexCaveMemProject(ctx.directory, {
					dataDir: options.dataDir,
					embeddingProvider: args.provider ?? options.embeddingProvider,
					searchAlpha: options.searchAlpha,
					searchDefaultLimit: defaultLimit,
				})
				return `provider=${result.provider} scanned=${result.scanned} updated=${result.updated}`
			},
		}),
	}
}

function formatObservationLine(entry: {
	id: number
	event: string
	sessionID: string
	timestamp: number
	content: string
}): string {
	return `- ${new Date(entry.timestamp).toISOString()} ${entry.sessionID} ${entry.event} #${entry.id} ${entry.content.replace(/\s+/g, ' ').trim().slice(0, 140)}`
}
