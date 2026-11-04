/**
 * `/team <task>`: the request rewritten as a coordinator brief for Multitask mode. The coordinator splits the work,
 * puts it on the shared board (so other terminals and `localpilot work` can take pieces too), runs its own workers,
 * keeps in touch through the board's mailbox, and integrates the results.
 */
export function teamPrompt(task: string): string {
  return `Team task: ${task.trim()}

You coordinate a team on this. Work in this order:
1. Scope: look at the code just enough to split the task well (analyze_workspace for anything repository-wide, then the files involved). Do not implement anything yourself.
2. Split: define independent pieces — each with a short title, an agent (coder, tester, docs, reviewer…), a self-contained brief (goal, exact files and symbols, constraints, how to verify, what to report) and the pieces it depends on. Two pieces that run at the same time must never edit the same file.
3. Board: add every piece to the shared board with team_board add (title, brief, priority, depends_on), so people and other agents working in this repository can see the plan and take pieces too.
4. Delegate: in the same turn, call run_todos_parallel once with the pieces nobody else has claimed (team_board list shows claims). Workers that finish should complete their board task with a summary.
5. Stay in touch: use team_board send (to an owner or a task id) or broadcast for handoffs and questions; messages for you arrive while you run, and team_board inbox reads them.
6. Integrate: when the workers report, check the combined result once (diagnostics, tests via run_command), delegate a follow-up piece for anything still broken, then summarise per piece what changed, how it was verified, and what is left on the board.`;
}
