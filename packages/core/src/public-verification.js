import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

import { rethrowIfAborted, throwIfAborted } from "./cancellation.js";
import { environmentTargetLabel } from "./environment-terminology.js";

const COLLECTOR_VERSION = "public-verification/v1";
const PROBE_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_PROBES = 4;

function probe({ id, kind, target, method, purpose, verificationMode }) {
  const url = new URL(target);
  return {
    probe_id: id,
    kind,
    target: url.toString(),
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method,
    purpose,
    timeout_ms: PROBE_TIMEOUT_MS,
    ...(verificationMode ? { verification_mode: verificationMode } : {}),
  };
}

export function createPublicVerificationPlan(answers) {
  const targets = answers?.production_targets ?? [];
  const journeys = answers?.core_journeys ?? [];
  const environment = answers?.intended_environment;
  const probes = [];

  targets.forEach((target, targetIndex) => {
    const url = new URL(target);
    const prefix = `target-${targetIndex + 1}`;
    probes.push(probe({
      id: `${prefix}:dns`,
      kind: "dns",
      target,
      method: "DNS_LOOKUP",
      purpose: `Resolve the ${environmentTargetLabel(environment)} host.`,
    }));
    if (url.protocol === "https:") {
      probes.push(probe({
        id: `${prefix}:tls`,
        kind: "tls",
        target,
        method: "TLS_HANDSHAKE",
        purpose: `Verify the ${environmentTargetLabel(environment)} certificate and TLS handshake.`,
      }));
    }
    probes.push(probe({
      id: `${prefix}:http`,
      kind: "http",
      target,
      method: "GET",
      purpose: "Verify HTTP reachability without following redirects.",
    }));
    probes.push(probe({
      id: `${prefix}:health`,
      kind: "health",
      target: new URL("/health", url.origin).toString(),
      method: "GET",
      purpose: "Verify the conventional public health endpoint.",
    }));
    journeys.forEach((journey, journeyIndex) => {
      const declaredJourney = typeof journey === "string"
        ? {
            purpose: journey,
            target,
            verificationMode: "description_only",
          }
        : {
            purpose: journey.purpose,
            target: new URL(journey.path, url.origin).toString(),
            verificationMode: "executable_path",
          };
      probes.push(probe({
        id: `${prefix}:journey-${journeyIndex + 1}`,
        kind: "journey",
        target: declaredJourney.target,
        method: "GET",
        purpose: `Verify declared core journey: ${declaredJourney.purpose}`,
        verificationMode: declaredJourney.verificationMode,
      }));
    });
  });

  return {
    collector_version: COLLECTOR_VERSION,
    targets: [...targets],
    probes,
  };
}

function timeoutError() {
  const error = new Error("public probe timed out");
  error.code = "PROBE_TIMEOUT";
  return error;
}

async function withTimeout(operation, timeoutMs, { signal } = {}) {
  throwIfAborted(signal);
  let timeout;
  let handleAbort;
  const operationPromise = Promise.resolve().then(operation);
  const abortPromise = signal && new Promise((resolve, reject) => {
    handleAbort = () => reject(signal.reason);
    if (signal.aborted) handleAbort();
    else signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    return await Promise.race([
      operationPromise,
      ...(abortPromise ? [abortPromise] : []),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

function request(probe, { signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const client = new URL(probe.target).protocol === "https:" ? https : http;
    let outgoing;
    let timeout;
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    try {
      outgoing = client.request(probe.target, {
        method: "GET",
        ...(signal ? { signal } : {}),
        headers: {
          accept: "*/*",
          "user-agent": `LaunchRally/${COLLECTOR_VERSION}`,
        },
      }, (response) => {
        clearTimeout(timeout);
        const result = {
          statusCode: response.statusCode,
          headers: response.headers,
        };
        response.destroy();
        resolve(result);
      });
    } catch (error) {
      fail(error);
      return;
    }
    timeout = setTimeout(() => outgoing.destroy(timeoutError()), probe.timeout_ms);
    outgoing.once("error", fail);
    outgoing.end();
  });
}

function tlsHandshake(probe, { signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let socket;
    let timeout;
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    try {
      socket = tls.connect({
        host: probe.host,
        port: probe.port,
        ...(signal ? { signal } : {}),
        ...(isIP(probe.host) === 0 ? { servername: probe.host } : {}),
        rejectUnauthorized: true,
      });
    } catch (error) {
      fail(error);
      return;
    }
    timeout = setTimeout(() => socket.destroy(timeoutError()), probe.timeout_ms);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      const details = {
        protocol: socket.getProtocol() ?? "unknown",
        authorized: socket.authorized,
      };
      socket.end();
      resolve(details);
    });
    socket.once("error", fail);
  });
}

function normalizedFailure(error) {
  if (error?.code === "PROBE_TIMEOUT" || error?.code === "ETIMEDOUT") {
    return { status: "unverified", outcome: "timeout" };
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(error?.code)) {
    return { status: "failed", outcome: "dns_failure" };
  }
  if (
    typeof error?.code === "string"
    && (
      error.code.includes("CERT")
      || error.code.includes("TLS")
      || error.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    )
  ) {
    return { status: "failed", outcome: "certificate_failure" };
  }
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(error?.code)) {
    return { status: "failed", outcome: "unreachable" };
  }
  return { status: "unverified", outcome: "execution_failure" };
}

function redirectTarget(location, base) {
  if (!location) return null;
  try {
    const target = new URL(location, base);
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    return target.toString();
  } catch {
    return "invalid";
  }
}

async function runProbe(probe, { signal } = {}) {
  throwIfAborted(signal);
  if (probe.kind === "dns") {
    const addresses = await withTimeout(
      () => dns.lookup(probe.host, { all: true, verbatim: true }),
      probe.timeout_ms,
      { signal },
    );
    return {
      status: "passed",
      outcome: "resolved",
      details: {
        addresses: addresses.map(({ address, family }) => ({ address, family })),
      },
    };
  }
  if (probe.kind === "tls") {
    return {
      status: "passed",
      outcome: "secure",
      details: await tlsHandshake(probe, { signal }),
    };
  }

  const response = await request(probe, { signal });
  const statusCode = response.statusCode ?? 0;
  const location = redirectTarget(response.headers.location, probe.target);
  if (statusCode >= 300 && statusCode < 400) {
    const targetMismatch = location && location !== "invalid"
      ? new URL(location).origin !== new URL(probe.target).origin
      : false;
    return {
      status: "failed",
      outcome: targetMismatch ? "target_mismatch" : "redirect_not_followed",
      details: { status_code: statusCode, redirect_target: location },
    };
  }
  const passed = statusCode >= 200 && statusCode < 300;
  if (passed && probe.kind === "journey" && probe.verification_mode === "description_only") {
    return {
      status: "unverified",
      outcome: "journey_definition_incomplete",
      details: { status_code: statusCode },
    };
  }
  return {
    status: passed ? "passed" : "failed",
    outcome: passed
      ? { http: "reachable", health: "healthy", journey: "completed" }[probe.kind]
      : "http_status_failure",
    details: { status_code: statusCode },
  };
}

async function collectProbe(probe, { signal } = {}) {
  throwIfAborted(signal);
  const startedAt = Date.now();
  const collectedAt = new Date().toISOString();
  let result;
  try {
    result = await runProbe(probe, { signal });
  } catch (error) {
    rethrowIfAborted(error, signal);
    result = { ...normalizedFailure(error), details: {} };
  }
  return {
    kind: "public_observation",
    probe_id: probe.probe_id,
    probe_kind: probe.kind,
    target: probe.target,
    host: probe.host,
    port: probe.port,
    path: probe.path,
    method: probe.method,
    purpose: probe.purpose,
    ...(probe.verification_mode ? { verification_mode: probe.verification_mode } : {}),
    status: result.status,
    outcome: result.outcome,
    collected_at: collectedAt,
    duration_ms: Date.now() - startedAt,
    details: result.details,
    provenance: {
      collector: COLLECTOR_VERSION,
      exact_target: probe.target,
      collected_at: collectedAt,
    },
  };
}

export async function collectPublicEvidence(plan, { signal } = {}) {
  throwIfAborted(signal);
  const evidence = new Array(plan.probes.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < plan.probes.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      evidence[index] = await collectProbe(plan.probes[index], { signal });
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_PROBES, plan.probes.length) },
      () => worker(),
    ),
  );
  throwIfAborted(signal);
  return evidence;
}
