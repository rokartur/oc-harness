import { spawn } from 'node:child_process'
import { ensureDir, readFileText, writeFileAtomic } from '../shared/fs.js'
import { join } from 'node:path'

export type DelegateJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DelegateJob {
	id: string
	label: string
	kind: string
	command: string
	status: DelegateJobStatus
	startedAt: number | null
	completedAt: number | null
	exitCode: number | null
	output: string
	error: string
}

export interface DelegateAuditEntry {
	jobId: string
	label: string
	kind: string
	status: DelegateJobStatus
	startedAt: number | null
	completedAt: number | null
}

export interface DelegateOptions {
	enabled: boolean
	maxConcurrent: number
	maxQueueSize: number
	dataDir: string
	workdir: string
}

const DEFAULT_OPTIONS: DelegateOptions = {
	enabled: false,
	maxConcurrent: 2,
	maxQueueSize: 20,
	dataDir: '',
	workdir: '',
}

export class DelegateService {
	private readonly options: DelegateOptions
	private readonly jobs = new Map<string, DelegateJob>()
	private nextId = 1

	constructor(options: Partial<DelegateOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options }
		if (this.options.dataDir) {
			this.loadFromDisk()
		}
	}

	start(label: string, kind: string, command: string): DelegateJob {
		if (!this.options.enabled) {
			return this.createRejected(label, kind, command, 'delegate disabled')
		}
		const queued = this.countByStatus('pending') + this.countByStatus('running')
		if (queued >= this.options.maxQueueSize) {
			return this.createRejected(label, kind, command, 'delegate queue full')
		}
		const id = `D${this.nextId++}`
		const job: DelegateJob = {
			id,
			label,
			kind,
			command,
			status: 'pending',
			startedAt: null,
			completedAt: null,
			exitCode: null,
			output: '',
			error: '',
		}
		this.jobs.set(id, job)
		this.runJob(id)
		return { ...job }
	}

	getStatus(id: string): DelegateJob | null {
		const job = this.jobs.get(id)
		return job ? { ...job } : null
	}

	list(status?: DelegateJobStatus): DelegateJob[] {
		const all = Array.from(this.jobs.values())
		return status ? all.filter(j => j.status === status) : all
	}

	cancel(id: string): DelegateJob | null {
		const job = this.jobs.get(id)
		if (!job) return null
		if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
			return { ...job }
		}
		job.status = 'cancelled'
		job.completedAt = Date.now()
		this.persist()
		return { ...job }
	}

	getAudit(): DelegateAuditEntry[] {
		return Array.from(this.jobs.values()).map(job => ({
			jobId: job.id,
			label: job.label,
			kind: job.kind,
			status: job.status,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
		}))
	}

	renderAudit(): string {
		const entries = this.getAudit()
		if (entries.length === 0) return 'No delegate jobs recorded.'
		const lines = ['## Delegate Audit', '']
		for (const entry of entries.slice(-10)) {
			const duration =
				entry.startedAt && entry.completedAt
					? ` ${((entry.completedAt - entry.startedAt) / 1000).toFixed(1)}s`
					: ''
			lines.push(`- ${entry.jobId} [${entry.status}] ${entry.label} (${entry.kind})${duration}`)
		}
		return lines.join('\n')
	}

	renderSummary(): string {
		const jobs = Array.from(this.jobs.values())
		if (jobs.length === 0) return ''
		const counts = {
			pending: this.countByStatus('pending'),
			running: this.countByStatus('running'),
			done: this.countByStatus('done'),
			failed: this.countByStatus('failed'),
			cancelled: this.countByStatus('cancelled'),
		}
		const latest = jobs
			.slice()
			.sort((left, right) => lastTouched(right) - lastTouched(left) || right.id.localeCompare(left.id))[0]
		const parts = [
			`jobs=${jobs.length}`,
			`running=${counts.running}`,
			`pending=${counts.pending}`,
			`done=${counts.done}`,
		]
		if (counts.failed > 0) parts.push(`failed=${counts.failed}`)
		if (counts.cancelled > 0) parts.push(`cancelled=${counts.cancelled}`)
		if (latest) parts.push(`latest=${latest.id}[${latest.status}] ${latest.label}`)
		return parts.join(' | ')
	}

	reset(): void {
		this.jobs.clear()
		this.nextId = 1
		this.persist()
	}

	private countByStatus(status: DelegateJobStatus): number {
		let count = 0
		for (const job of this.jobs.values()) {
			if (job.status === status) count++
		}
		return count
	}

	private createRejected(label: string, kind: string, command: string, reason: string): DelegateJob {
		const id = `D${this.nextId++}`
		const job: DelegateJob = {
			id,
			label,
			kind,
			command,
			status: 'failed',
			startedAt: null,
			completedAt: Date.now(),
			exitCode: null,
			output: '',
			error: reason,
		}
		this.jobs.set(id, job)
		return job
	}

	private runJob(id: string): void {
		const job = this.jobs.get(id)
		if (!job || job.status !== 'pending') return
		if (this.countByStatus('running') >= this.options.maxConcurrent) return

		job.status = 'running'
		job.startedAt = Date.now()
		this.persist()

		const child = spawn('sh', ['-c', job.command], {
			cwd: this.options.workdir || this.options.dataDir || undefined,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 120_000,
		})

		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
			if (stdout.length > 100_000) stdout = stdout.slice(-100_000)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
			if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
		})

		child.on('close', code => {
			job.exitCode = code ?? 0
			job.output = stdout.trim()
			job.error = stderr.trim()
			job.status = code === 0 ? 'done' : 'failed'
			job.completedAt = Date.now()
			this.persist()
			this.runNextPending()
		})

		child.on('error', err => {
			job.status = 'failed'
			job.error = err.message
			job.completedAt = Date.now()
			this.persist()
			this.runNextPending()
		})
	}

	private runNextPending(): void {
		for (const job of this.jobs.values()) {
			if (job.status === 'pending') {
				this.runJob(job.id)
				return
			}
		}
	}

	private persist(): void {
		if (!this.options.dataDir) return
		ensureDir(this.options.dataDir)
		const data = {
			nextId: this.nextId,
			jobs: Array.from(this.jobs.entries()),
		}
		writeFileAtomic(join(this.options.dataDir, 'delegate.json'), JSON.stringify(data, null, 2))
	}

	private loadFromDisk(): void {
		if (!this.options.dataDir) return
		const raw = readFileText(join(this.options.dataDir, 'delegate.json'))
		if (!raw) return
		try {
			const data = JSON.parse(raw) as { nextId?: number; jobs?: Array<[string, DelegateJob]> }
			if (typeof data.nextId === 'number') this.nextId = data.nextId
			if (Array.isArray(data.jobs)) {
				for (const [key, value] of data.jobs) {
					this.jobs.set(key, value)
				}
			}
			for (const job of this.jobs.values()) {
				if (job.status === 'running' || job.status === 'pending') {
					job.status = 'cancelled'
					job.completedAt = job.completedAt || Date.now()
				}
			}
		} catch {
			// ignore corrupted data
		}
	}
}

function lastTouched(job: DelegateJob): number {
	return job.completedAt ?? job.startedAt ?? 0
}
