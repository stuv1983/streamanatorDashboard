/**
 * Docker container inventory.
 * 
 * Uses the `docker` CLI rather than the socket API.
 */

import { runCommand } from './system';

export class DockerUnavailable extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DockerUnavailable";
    }
}

export class ContainerInfo {
    /** Full container id; changes whenever the container is recreated. */
    id: string;
    name: string;
    image: string;
    /** The image's declared version label, when the image publishes one. */
    version: string;
    state: string;
    status: string;
    health: string | null;
    started_at: number | null;
    restart_count: number;
    exit_code: number | null;
    /** Host port -> container port publications. */
    ports: Record<string, string>;
    compose_project: string;
    labels: Record<string, string>;
    /** Set when the container joins another container's network namespace */
    network_mode: string;
    image_id: string;
    /** When this container object was created */
    created_at: number | null;
    /** Non-secret environment settings (see PUBLIC_ENV_KEYS); everything else is dropped. */
    public_env: Record<string, string>;

    constructor(init: Partial<ContainerInfo>) {
        this.id = init.id ?? "";
        this.name = init.name ?? "";
        this.image = init.image ?? "";
        this.version = init.version ?? "";
        this.state = init.state ?? "";
        this.status = init.status ?? "";
        this.health = init.health ?? null;
        this.started_at = init.started_at ?? null;
        this.restart_count = init.restart_count ?? 0;
        this.exit_code = init.exit_code ?? null;
        this.ports = init.ports ?? {};
        this.compose_project = init.compose_project ?? "";
        this.labels = init.labels ?? {};
        this.network_mode = init.network_mode ?? "";
        this.image_id = init.image_id ?? "";
        this.created_at = init.created_at ?? null;
        this.public_env = init.public_env ?? {};
    }

    get running(): boolean {
        return this.state === "running";
    }

    get healthy(): boolean | null {
        if (this.health === null) {
            return null;
        }
        return this.health === "healthy";
    }

    get uptime_seconds(): number | null {
        if (this.started_at === null || !this.running) {
            return null;
        }
        return Math.max(0.0, (Date.now() / 1000) - this.started_at);
    }

    get behind_container(): string | null {
        if (this.network_mode.startsWith("container:")) {
            return this.network_mode.substring("container:".length);
        }
        return null;
    }

    /** Getters are not own properties, so JSON.stringify would drop them from the snapshot. */
    toJSON() {
        return {
            ...this,
            running: this.running,
            healthy: this.healthy,
            uptime_seconds: this.uptime_seconds,
            behind_container: this.behind_container,
        };
    }
}

function _parse_docker_time(value: string | null | undefined): number | null {
    if (!value || value.startsWith("0001-01-01")) {
        return null;
    }
    const parsed = Date.parse(value);
    if (isNaN(parsed)) {
        return null;
    }
    return parsed / 1000.0;
}

/**
 * Environment variables safe to carry into a snapshot. `docker inspect` returns
 * every variable, credentials included, so this is an allow-list: Gluetun's
 * provider, tunnel type and server filters explain most tunnel failures, and
 * none of them is a secret.
 */
export const PUBLIC_ENV_KEYS = new Set([
    "VPN_SERVICE_PROVIDER",
    "VPN_TYPE",
    "SERVER_COUNTRIES",
    "SERVER_REGIONS",
    "SERVER_CITIES",
    "SERVER_HOSTNAMES",
    "SERVER_CATEGORIES",
    "VPN_PORT_FORWARDING",
    "HTTP_CONTROL_SERVER_ADDRESS",
]);

export function _parse_public_env(env: string[] | null | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of env ?? []) {
        const idx = entry.indexOf("=");
        if (idx <= 0) continue;
        const key = entry.substring(0, idx);
        if (PUBLIC_ENV_KEYS.has(key)) {
            result[key] = entry.substring(idx + 1);
        }
    }
    return result;
}

function _parse_ports(port_bindings: Record<string, any[]> | null | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!port_bindings) {
        return result;
    }
    for (const [container_port, bindings] of Object.entries(port_bindings)) {
        if (!bindings || !Array.isArray(bindings)) {
            continue;
        }
        for (const binding of bindings) {
            const host_port = binding.HostPort;
            let host_ip = binding.HostIp || "";
            if (!host_port) {
                continue;
            }
            if (host_ip === "::" || host_ip === "") {
                host_ip = "0.0.0.0";
            }
            result[`${host_ip}:${host_port}`] = container_port;
        }
    }
    return result;
}

export async function list_containers(timeout: number = 8.0): Promise<ContainerInfo[]> {
    let code: number, stdout: string, stderr: string;
    
    try {
        const res = (await runCommand(["docker", "ps", "-a", "--no-trunc", "--format", "{{.Names}}"], timeout)) as any;
        code = res[0];
        stdout = res[1];
        stderr = res[2];
    } catch (e: any) {
        throw new DockerUnavailable(e.message || "docker ps failed");
    }

    if (code !== 0) {
        throw new DockerUnavailable(stderr.trim() || "docker ps failed");
    }

    const names = stdout.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    if (names.length === 0) {
        return [];
    }

    try {
        const res = (await runCommand(["docker", "inspect", ...names], timeout + 4.0)) as any;
        code = res[0];
        stdout = res[1];
        stderr = res[2];
    } catch (e: any) {
        throw new DockerUnavailable(e.message || "docker inspect failed");
    }

    if (code !== 0) {
        throw new DockerUnavailable(stderr.trim() || "docker inspect failed");
    }

    let payload: any[];
    try {
        payload = JSON.parse(stdout);
    } catch (exc: any) {
        throw new DockerUnavailable(`could not parse docker inspect output: ${exc.message}`);
    }

    const containers: ContainerInfo[] = [];
    for (const item of payload) {
        const state = item.State || {};
        const config = item.Config || {};
        const labels = config.Labels || {};
        const network = item.NetworkSettings || {};
        const host_config = item.HostConfig || {};
        const health_block = state.Health;

        containers.push(new ContainerInfo({
            id: item.Id || "",
            name: (item.Name || "").replace(/^\//, ""),
            image: config.Image || item.Image || "",
            version: labels["org.opencontainers.image.version"] || "",
            state: state.Status || "unknown",
            status: _status_text(state),
            health: health_block ? health_block.Status : null,
            started_at: _parse_docker_time(state.StartedAt),
            restart_count: parseInt(item.RestartCount || "0", 10) || 0,
            exit_code: state.ExitCode ?? null,
            ports: _parse_ports(network.Ports),
            compose_project: labels["com.docker.compose.project"] || "",
            labels: labels,
            network_mode: host_config.NetworkMode || "",
            image_id: item.Image || "",
            created_at: _parse_docker_time(item.Created),
            public_env: _parse_public_env(config.Env)
        }));
    }
    return containers;
}

function _status_text(state: any): string {
    const status = state?.Status || "unknown";
    if (status === "running") {
        const started = _parse_docker_time(state.StartedAt);
        if (started) {
            const d = new Date(started * 1000);
            const day = d.getDate().toString().padStart(2, '0');
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const month = months[d.getMonth()];
            const hours = d.getHours().toString().padStart(2, '0');
            const minutes = d.getMinutes().toString().padStart(2, '0');
            return `Up since ${day} ${month} ${hours}:${minutes}`;
        }
    }
    if (status === "exited") {
        return `Exited (${state?.ExitCode})`;
    }
    return status;
}

export function find_container(
    containers: Iterable<ContainerInfo>, 
    expected_name: string
): ContainerInfo | null {
    const container_list = Array.from(containers);
    for (const container of container_list) {
        if (container.name === expected_name) {
            return container;
        }
    }

    const normalise = (name: string) => name.replace(/[-_]/g, "").toLowerCase();
    const target = normalise(expected_name);
    
    for (const container of container_list) {
        if (normalise(container.name) === target) {
            return container;
        }
    }

    let service = expected_name;
    for (const prefix of ["media-vpn_", "media-vpn-"]) {
        if (service.startsWith(prefix)) {
            service = service.substring(prefix.length);
        }
    }
    service = service.replace(/[-_]\d+$/, "");
    for (const container of container_list) {
        if (container.labels["com.docker.compose.service"] === service) {
            return container;
        }
    }
    return null;
}

export async function getContainerLogs(
    name: string, lines: number = 50, timeout: number = 8.0
): Promise<string[]> {
    try {
        const res = (await runCommand(["docker", "logs", "--tail", lines.toString(), name], timeout)) as any;
        if (res[0] !== 0) {
            return [];
        }
        const combined = `${res[1]}\n${res[2]}`.trim();
        return combined.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    } catch {
        return [];
    }
}

export async function execReadonly(
    container: string, args: string[], timeout: number = 10.0
): Promise<{code: number, output: string}> {
    try {
        const res = (await runCommand(["docker", "exec", container, ...args], timeout)) as any;
        return {code: res[0], output: res[1].trim() || res[2].trim()};
    } catch (e: any) {
        return {code: -1, output: e.message || "Failed to execute docker exec"};
    }
}

export interface ImageInfo {
    image_id: string;
    created: number | null;
    repo_digests: string[];
    repo_tags: string[];
}

export async function image_details(image_ids: Iterable<string>, timeout: number = 10.0): Promise<Record<string, ImageInfo>> {
    const idSet = new Set(Array.from(image_ids).filter(Boolean));
    const ids = Array.from(idSet).sort();
    if (ids.length === 0) {
        return {};
    }

    let code: number, stdout: string, stderr: string;
    try {
        const res = (await runCommand(["docker", "image", "inspect", ...ids], timeout)) as any;
        code = res[0];
        stdout = res[1];
        stderr = res[2];
    } catch {
        return {};
    }

    if (!stdout.trim()) {
        console.debug(`docker image inspect returned nothing (rc=${code}): ${stderr.substring(0, 200)}`);
        return {};
    }

    let payload: any[];
    try {
        payload = JSON.parse(stdout);
    } catch {
        return {};
    }

    const details: Record<string, ImageInfo> = {};
    for (const item of payload) {
        const image_id = item.Id || "";
        if (!image_id) continue;
        details[image_id] = {
            image_id,
            created: _parse_docker_time(item.Created),
            repo_digests: item.RepoDigests || [],
            repo_tags: item.RepoTags || []
        };
    }
    return details;
}

export function compose_project_dirs(containers: Iterable<ContainerInfo>): Record<string, string> {
    const found: Record<string, string> = {};
    for (const container of containers) {
        const project = container.labels["com.docker.compose.project"] || "";
        const working_dir = container.labels["com.docker.compose.project.working_dir"] || "";
        if (project && working_dir) {
            if (!(project in found)) {
                found[project] = working_dir;
            }
        }
    }
    return found;
}

export async function docker_version(timeout: number = 5.0): Promise<Record<string, string>> {
    const info: Record<string, string> = {};
    
    try {
        const res = (await runCommand(["docker", "version", "--format", "{{.Server.Version}}"], timeout)) as any;
        if (res[0] === 0 && res[1].trim()) {
            info["engine"] = res[1].trim();
        }
    } catch {}

    try {
        const res = (await runCommand(["docker", "compose", "version", "--short"], timeout)) as any;
        if (res[0] === 0 && res[1].trim()) {
            info["compose_v2"] = res[1].trim();
        }
    } catch {}

    try {
        const res = (await runCommand(["docker-compose", "--version"], timeout)) as any;
        if (res[0] === 0 && res[1].trim()) {
            info["compose_v1"] = res[1].trim();
        }
    } catch {}

    return info;
}
