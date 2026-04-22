export interface PendingTodoItem {
	status: string
	content: string
}

export class PendingTodosTracker {
	private readonly todosBySession = new Map<string, PendingTodoItem[]>()
	private readonly lastReminderKey = new Map<string, string>()

	update(sessionID: string, todos: PendingTodoItem[]): void {
		this.todosBySession.set(sessionID, todos.slice())
	}

	pending(sessionID: string): PendingTodoItem[] {
		return (this.todosBySession.get(sessionID) ?? []).filter(
			todo => todo.status === 'pending' || todo.status === 'in_progress',
		)
	}

	buildReminder(sessionID: string): string | null {
		const pending = this.pending(sessionID)
		if (pending.length === 0) return null
		const key = pending
			.map(todo => `${todo.status}:${todo.content}`)
			.sort()
			.join('\n')
		if (this.lastReminderKey.get(sessionID) === key) return null
		this.lastReminderKey.set(sessionID, key)
		const lines = ['Pending todos remain.', '']
		for (const todo of pending) lines.push(`- [${todo.status}] ${todo.content}`)
		return lines.join('\n')
	}

	reset(sessionID: string): void {
		this.todosBySession.delete(sessionID)
		this.lastReminderKey.delete(sessionID)
	}
}
