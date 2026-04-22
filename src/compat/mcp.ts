import { readFileText, fileExists } from '../shared/fs.js'
import { MAX_MCP_SERVERS_PER_PLUGIN } from '../shared/limits.js'
import type { CompatMcpServer, PluginDiagnostic } from '../shared/types.js'

export function loadMcpFromPlugin(
	pluginDir: string,
	mcpFile: string,
	diagnostics: PluginDiagnostic[] = [],
	pluginName: string = basename(pluginDir),
): Record<string, CompatMcpServer> {
	const primary = `${pluginDir}/${mcpFile}`
	const fallback = `${pluginDir}/.mcp.json`

	let raw: string | null = null
	if (fileExists(primary)) {
		raw = readFileText(primary)
	} else if (fileExists(fallback)) {
		raw = readFileText(fallback)
	}

	if (!raw) return {}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const servers = parsed['mcpServers'] ?? parsed
		if (typeof servers !== 'object' || servers == null || Array.isArray(servers)) {
			diagnostics.push({
				level: 'error',
				pluginName,
				message: `Malformed MCP file '${mcpFile}': expected object map`,
			})
			return {}
		}

		const result: Record<string, CompatMcpServer> = {}
		let count = 0

		for (const [name, config] of Object.entries(servers)) {
			if (count >= MAX_MCP_SERVERS_PER_PLUGIN) break
			if (typeof config !== 'object' || config == null) {
				diagnostics.push({
					level: 'warn',
					pluginName,
					message: `Skipping malformed MCP server '${name}'`,
				})
				continue
			}
			const validated = validateMcpServerConfig(name, config as Record<string, unknown>, diagnostics, pluginName)
			if (!validated) continue
			result[name] = validated
			count++
		}

		return result
	} catch (error) {
		diagnostics.push({
			level: 'error',
			pluginName,
			message: `Malformed MCP file '${mcpFile}'`,
			detail: String(error),
		})
		return {}
	}
}

function basename(path: string): string {
	return path.split('/').pop() ?? 'unknown'
}

function validateMcpServerConfig(
	name: string,
	config: Record<string, unknown>,
	diagnostics: PluginDiagnostic[],
	pluginName: string,
): CompatMcpServer | null {
	if (typeof config['type'] !== 'string' || !config['type'].trim()) {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': missing type`,
		})
		return null
	}

	const type = config['type'].trim()
	const command = config['command']
	const url = config['url']
	const args = config['args']
	const headers = config['headers']

	if (command != null && typeof command !== 'string') {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': command must be string`,
		})
		return null
	}
	if (url != null && typeof url !== 'string') {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': url must be string`,
		})
		return null
	}
	if (args != null && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': args must be string[]`,
		})
		return null
	}
	if (headers != null) {
		if (typeof headers !== 'object' || headers == null || Array.isArray(headers)) {
			diagnostics.push({
				level: 'warn',
				pluginName,
				message: `Skipping malformed MCP server '${name}': headers must be object`,
			})
			return null
		}
		for (const value of Object.values(headers)) {
			if (typeof value !== 'string') {
				diagnostics.push({
					level: 'warn',
					pluginName,
					message: `Skipping malformed MCP server '${name}': header values must be strings`,
				})
				return null
			}
		}
	}
	if (type === 'stdio' && (typeof command !== 'string' || !command.trim())) {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': stdio server missing command`,
		})
		return null
	}
	if ((type === 'http' || type === 'sse') && (typeof url !== 'string' || !url.trim())) {
		diagnostics.push({
			level: 'warn',
			pluginName,
			message: `Skipping malformed MCP server '${name}': ${type} server missing url`,
		})
		return null
	}

	return {
		type,
		...(typeof command === 'string' ? { command } : {}),
		...(typeof url === 'string' ? { url } : {}),
		...(Array.isArray(args) ? { args: [...args] } : {}),
		...(headers && typeof headers === 'object' && !Array.isArray(headers)
			? { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])) }
			: {}),
	}
}
