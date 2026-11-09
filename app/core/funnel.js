import { existsSync } from "node:fs";
import { run } from "../../src/util.js";
import { tailscaleCandidates } from "./machines.js";

function bin() {
  const path = tailscaleCandidates().find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Instala Tailscale para activar el acceso remoto.");
  return path;
}

export function publicBaseUrl(status) {
  const name = status?.Self?.DNSName?.replace(/\.$/, "");
  return name ? `https://${name}` : null;
}

export async function readBaseUrl() {
  const result = await run(bin(), ["status", "--json"], { timeoutMs: 8_000 });
  if (result.code !== 0) throw new Error("Inicia sesión en Tailscale para activar el acceso remoto.");
  const url = publicBaseUrl(JSON.parse(result.stdout));
  if (!url) throw new Error("Tailscale no reporta un nombre para esta computadora.");
  return url;
}

export function funnelTargets(status, port) {
  const host = Object.values(status?.Web ?? {})
    .flatMap((web) => Object.values(web?.Handlers ?? {}))
    .map((handler) => handler?.Proxy ?? "");
  return host.some((proxy) => proxy.includes(`:${port}`)) && Object.values(status?.AllowFunnel ?? {}).some(Boolean);
}

export async function isFunnelOn(port) {
  const result = await run(bin(), ["funnel", "status", "--json"], { timeoutMs: 8_000 });
  if (result.code !== 0) return false;
  try {
    return funnelTargets(JSON.parse(result.stdout), port);
  } catch {
    return false;
  }
}

export async function enableFunnel(port) {
  const result = await run(bin(), ["funnel", "--bg", "--yes", String(port)], { timeoutMs: 20_000 });
  if (result.code === 0 && (await isFunnelOn(port))) return;
  const detail = `${result.stderr}\n${result.stdout}`;
  const link = detail.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
  throw new Error(link ? `Tailscale necesita que apruebes Funnel en: ${link}` : "No se pudo activar Tailscale Funnel.");
}

export async function disableFunnel() {
  await run(bin(), ["funnel", "--https=443", "off"], { timeoutMs: 15_000 });
}
