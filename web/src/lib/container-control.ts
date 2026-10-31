// Docker start/stop/restart, gated the same way as process control:
//   1. the caller holds an admin session AND re-enters the password (step-up);
//   2. the target must be a container docker currently lists, matched by its
//      exact name and id, so a container recreated since page load is refused;
//   3. the result names every container sharing the target's network
//      namespace, since stopping Gluetun takes the whole media stack with it.
// Recreate/pull stay with the stack updater: this only changes run state.

import { list_containers, type ContainerInfo } from "./docker_service";
import { runCommand } from "./system";

export const CONTAINER_ACTIONS = ["start", "stop", "restart"] as const;
export type ContainerAction = typeof CONTAINER_ACTIONS[number];

export type ContainerRequest = { action: ContainerAction; name: string; id: string };
export type ContainerResult = { ok: true; message: string } | { ok: false; status: number; message: string };

export function parseContainerRequest(body: unknown): ContainerRequest | string {
  if (!body || typeof body !== "object") return "Expected a JSON object.";
  const b = body as Record<string, unknown>;
  if (!CONTAINER_ACTIONS.includes(b.action as ContainerAction)) return `action must be one of ${CONTAINER_ACTIONS.join(", ")}.`;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  // Docker's own container-name grammar; anything else never reaches argv.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return "name must be a Docker container name.";
  const id = typeof b.id === "string" ? b.id : "";
  if (!/^[a-f0-9]{12,64}$/.test(id)) return "id is required so a recreated container cannot be hit by mistake.";
  return { action: b.action as ContainerAction, name, id };
}

/** Containers that share this one's network namespace (network_mode: container:<name>). */
export function dependants(target: ContainerInfo, containers: ContainerInfo[]): string[] {
  return containers
    .filter(c => c.name !== target.name && c.behind_container !== null
      && (c.behind_container === target.name || (target.id !== "" && c.behind_container === target.id)))
    .map(c => c.name);
}

export function refusalReason(request: ContainerRequest, container: ContainerInfo): string | null {
  if (request.action === "start" && container.running) return `${container.name} is already running.`;
  if (request.action === "stop" && !container.running) return `${container.name} is not running.`;
  if (!container.id.startsWith(request.id)) {
    return `${container.name} has been recreated since the page loaded. Refresh and try again.`;
  }
  return null;
}

export async function executeContainerAction(request: ContainerRequest): Promise<ContainerResult> {
  let containers: ContainerInfo[];
  try {
    containers = await list_containers(10);
  } catch (error) {
    return { ok: false, status: 503, message: `Docker is unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const container = containers.find(c => c.name === request.name);
  if (!container) return { ok: false, status: 404, message: `No container named ${request.name}.` };
  const reason = refusalReason(request, container);
  if (reason) return { ok: false, status: 409, message: reason };

  // stop/restart give the container docker's default 10 s to exit cleanly.
  const [code, , stderr] = await runCommand(["docker", request.action, container.name], 60);
  if (code !== 0) {
    return { ok: false, status: 502, message: `docker ${request.action} ${container.name} failed: ${stderr.trim().slice(0, 300)}` };
  }
  const affected = request.action === "start" ? [] : dependants(container, containers);
  const note = affected.length ? ` ${affected.join(", ")} share its network and lose connectivity until it is back.` : "";
  return { ok: true, message: `${container.name}: ${request.action} done.${note}` };
}
