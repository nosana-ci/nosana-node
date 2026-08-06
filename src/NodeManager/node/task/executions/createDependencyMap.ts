import TaskManager, { TaskManagerOps } from '../TaskManager.js';

/**
 * Creates a dependency map for all operations.
 *
 * Returns a Map of operation ID -> {
 *   dependencies: operation IDs this op waits for
 *   dependents: operation IDs that wait for this op
 * }
 *
 * This allows the task manager to:
 * - Dynamically trigger downstream ops when upstream completes
 * - Track dependencies and dependents efficiently during execution
 * - Use alongside the execution plan to resolve execution flow
 *
 * `depends_on` is read in one of two directions. On an op that also sets
 * `stop_if_dependent_stops` it names the ops that op serves: a server is stopped
 * once they finish, so it has to be running before they start. Everywhere else
 * it names what the op waits for.
 *
 * The direction matters because a client reaches its server by hostname, and
 * that name exists only once the server's container does — after the server has
 * pulled its image and fetched its resources. Starting the client first puts all
 * of that inside the client's own wait.
 */
export function createDependencyMap(
  this: TaskManager,
): Map<string, { dependencies: string[]; dependents: string[] }> {
  const map = new Map<
    string,
    { dependencies: string[]; dependents: string[] }
  >();

  for (const op of this.operations as TaskManagerOps) {
    map.set(op.id, { dependencies: [], dependents: [] });
  }

  for (const op of this.operations as TaskManagerOps) {
    const declared = op.execution?.depends_on ?? [];
    const serves = op.execution?.stop_if_dependent_stops === true;

    for (const otherId of declared) {
      if (!map.has(otherId)) continue;

      if (serves) {
        map.get(op.id)!.dependents.push(otherId);
        map.get(otherId)!.dependencies.push(op.id);
      } else {
        map.get(op.id)!.dependencies.push(otherId);
        map.get(otherId)!.dependents.push(op.id);
      }
    }
  }

  return map;
}
