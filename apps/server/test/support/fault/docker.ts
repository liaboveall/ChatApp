/** Thin wrappers over the docker CLI for the fault-test environment. Every command names containers by full id. */
import { $ } from 'bun'

export type ContainerInfo = {
  id: string
  name: string
  running: boolean
  startedAt: string
  labels: Record<string, string>
  /** container port ("5432/tcp") -> published host bindings */
  ports: Record<string, Array<{ hostIp: string; hostPort: number }>>
  mounts: Array<{ type: string; name: string; source: string }>
}

export async function inspectContainer(id: string): Promise<ContainerInfo | undefined> {
  const result = await $`docker inspect ${id}`.quiet().nothrow()
  if (result.exitCode !== 0) return undefined
  const [raw] = JSON.parse(result.stdout.toString()) as Array<{
    Id: string
    Name: string
    State: { Running: boolean; StartedAt: string }
    Config: { Labels: Record<string, string> | null }
    NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> }
    Mounts: Array<{ Type: string; Name?: string; Source: string }>
  }>
  if (!raw) return undefined
  const ports: ContainerInfo['ports'] = {}
  for (const [port, bindings] of Object.entries(raw.NetworkSettings.Ports)) {
    ports[port] = (bindings ?? []).map((b) => ({ hostIp: b.HostIp, hostPort: Number(b.HostPort) }))
  }
  return {
    id: raw.Id,
    name: raw.Name.replace(/^\//, ''),
    running: raw.State.Running,
    startedAt: raw.State.StartedAt,
    labels: raw.Config.Labels ?? {},
    ports,
    mounts: raw.Mounts.map((m) => ({ type: m.Type, name: m.Name ?? '', source: m.Source })),
  }
}

export async function inspectVolume(
  name: string,
): Promise<{ name: string; labels: Record<string, string> } | undefined> {
  const result = await $`docker volume inspect ${name}`.quiet().nothrow()
  if (result.exitCode !== 0) return undefined
  const [raw] = JSON.parse(result.stdout.toString()) as Array<{
    Name: string
    Labels: Record<string, string> | null
  }>
  return raw ? { name: raw.Name, labels: raw.Labels ?? {} } : undefined
}

export async function inspectNetwork(
  id: string,
): Promise<{ id: string; labels: Record<string, string> } | undefined> {
  const result = await $`docker network inspect ${id}`.quiet().nothrow()
  if (result.exitCode !== 0) return undefined
  const [raw] = JSON.parse(result.stdout.toString()) as Array<{
    Id: string
    Labels: Record<string, string> | null
  }>
  return raw ? { id: raw.Id, labels: raw.Labels ?? {} } : undefined
}

export async function dockerAction(
  action: 'stop' | 'start' | 'kill' | 'restart' | 'pause' | 'unpause',
  id: string,
): Promise<void> {
  const result = await $`docker ${action} ${id}`.quiet().nothrow()
  if (result.exitCode !== 0) throw new Error(`docker ${action} failed`)
}
