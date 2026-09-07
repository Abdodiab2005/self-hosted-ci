import "dotenv/config";

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAppAuth } from "@octokit/auth-app";
import express from "express";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 5050);
const ZONE = process.env.SCW_DEFAULT_ZONE || "fr-par-1";
const INSTANCE_TYPE = process.env.SCW_INSTANCE_TYPE || "DEV1-M";
const WORKER_NAME = process.env.SCW_WORKER_NAME || "leviro-ci-worker";
const RUNNER_LABEL = process.env.RUNNER_LABEL || "scaleway-ci";
const CONTROLLER_URL =
  process.env.CONTROLLER_PUBLIC_URL || "https://ci.leviro.net";
const IDLE_MS = Number(process.env.INSTANCE_IDLE_MINUTES || 3) * 60 * 1000;
const STATE_FILE = path.resolve("./data/state.json");
const SCW_MAX_BUFFER = 10 * 1024 * 1024;
const POWER_TRANSITION_TIMEOUT_MS = 120_000;

for (const name of [
  "GITHUB_APP_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PRIVATE_KEY_PATH",
  "WORKER_SECRET",
]) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const privateKey = fs.readFileSync(
  process.env.GITHUB_PRIVATE_KEY_PATH,
  "utf8",
);

const app = express();
let workerTransitioning = false;

function defaultState() {
  return { queue: [], worker: null };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      worker: parsed.worker || null,
    };
  } catch {
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function verifyGithubSignature(rawBody, signature) {
  if (!signature?.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWorker(req) {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const supplied = authorization.slice(7);
  const expected = process.env.WORKER_SECRET;
  if (!supplied || !expected) return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function githubInstallationToken(installationId) {
  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID,
    privateKey,
    installationId,
  });
  const result = await auth({ type: "installation" });
  return result.token;
}

async function runnerRegistrationToken({ installationId, owner, repo }) {
  const installationToken = await githubInstallationToken(installationId);
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runners/registration-token`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${installationToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub registration token failed: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()).token;
}

function createWorkerCloudInit() {
  const workerScript = `#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
export RUNNER_ALLOW_RUNASROOT=1

CONTROLLER="${CONTROLLER_URL}"
WORKER_SECRET="${process.env.WORKER_SECRET}"
RUNNER_LABEL="${RUNNER_LABEL}"
PROVISION_DIR="/opt/leviro-ci"
PROVISION_MARKER="$PROVISION_DIR/provisioned-v2"
RUNNER_TEMPLATE="/opt/actions-runner-template"

exec > >(tee -a /var/log/leviro-ci-worker.log) 2>&1

echo "[WORKER] =========================================="
echo "[WORKER] Leviro CI worker starting"
echo "[WORKER] =========================================="

baseline_ok() {
  local required=(curl wget git jq zip unzip tar python3 gcc g++ make gh docker)
  local cmd
  for cmd in "\${required[@]}"; do
    command -v "$cmd" >/dev/null 2>&1 || return 1
  done
  docker compose version >/dev/null 2>&1 || return 1
  docker buildx version >/dev/null 2>&1 || return 1
  return 0
}

provision_baseline() {
  echo "[WORKER] Provisioning base CI toolchain"

  apt-get update
  apt-get install -y \
    ca-certificates \
    curl \
    wget \
    git \
    jq \
    zip \
    unzip \
    tar \
    gzip \
    xz-utils \
    sudo \
    gnupg \
    openssh-client \
    rsync \
    build-essential \
    python3 \
    python3-pip \
    pkg-config \
    gh

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(. /etc/os-release; echo "\${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  systemctl enable docker
  systemctl start docker

  mkdir -p "$PROVISION_DIR"
  touch "$PROVISION_MARKER"
}

if [ ! -f "$PROVISION_MARKER" ] || ! baseline_ok; then
  rm -f "$PROVISION_MARKER"
  provision_baseline
else
  echo "[WORKER] Reusing persistent CI toolchain"
  systemctl start docker || true
fi

if ! baseline_ok; then
  echo "[WORKER] ERROR: baseline validation failed"
  exit 1
fi

docker version
docker compose version
docker buildx version

ensure_runner_template() {
  local latest current
  latest="$(
    curl -fsSL https://api.github.com/repos/actions/runner/releases/latest |
      jq -r '.tag_name' |
      sed 's/^v//'
  )"

  if [ -z "$latest" ] || [ "$latest" = "null" ]; then
    echo "[WORKER] ERROR: failed to detect GitHub Actions Runner version"
    return 1
  fi

  current=""
  if [ -f "$RUNNER_TEMPLATE/.leviro-runner-version" ]; then
    current="$(cat "$RUNNER_TEMPLATE/.leviro-runner-version")"
  fi

  if [ "$current" = "$latest" ] && [ -x "$RUNNER_TEMPLATE/run.sh" ]; then
    echo "[WORKER] Reusing Actions Runner $current"
    return 0
  fi

  echo "[WORKER] Installing Actions Runner $latest"
  rm -rf "$RUNNER_TEMPLATE"
  mkdir -p "$RUNNER_TEMPLATE"
  cd "$RUNNER_TEMPLATE"

  curl -fsSL -o /tmp/actions-runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v$latest/actions-runner-linux-x64-$latest.tar.gz"
  tar xzf /tmp/actions-runner.tar.gz
  rm -f /tmp/actions-runner.tar.gz
  ./bin/installdependencies.sh
  printf '%s' "$latest" > .leviro-runner-version
}

ensure_runner_template

cleanup_job() {
  echo "[WORKER] Cleaning previous job"
  rm -rf /opt/actions-runner-job /tmp/leviro-ci-* 2>/dev/null || true

  docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network prune -f >/dev/null 2>&1 || true
  docker volume prune -f >/dev/null 2>&1 || true

  # Docker images and build cache intentionally survive power cycles to speed up CI.
}

cleanup_job

echo "[WORKER] Ready for jobs"

while true; do
  RESPONSE=""

  if ! RESPONSE="$(
    curl -fsS \
      --connect-timeout 10 \
      --max-time 30 \
      -X POST \
      -H "Authorization: Bearer $WORKER_SECRET" \
      -H "Content-Type: application/json" \
      "$CONTROLLER/internal/next" \
      -d '{}'
  )"; then
    echo "[WORKER] Controller unavailable, retrying..."
    sleep 5
    continue
  fi

  if [ "$(echo "$RESPONSE" | jq -r '.task != null')" != "true" ]; then
    sleep "$(echo "$RESPONSE" | jq -r '.waitSeconds // 3')"
    continue
  fi

  REPO="$(echo "$RESPONSE" | jq -r '.task.repoFullName')"
  TOKEN="$(echo "$RESPONSE" | jq -r '.task.token')"
  RUNNER_NAME="$(echo "$RESPONSE" | jq -r '.task.runnerName')"

  echo "[WORKER] Registering $RUNNER_NAME for $REPO"
  cleanup_job

  mkdir -p /opt/actions-runner-job
  cp -a "$RUNNER_TEMPLATE/." /opt/actions-runner-job/
  cd /opt/actions-runner-job

  if ! ./config.sh \
      --unattended \
      --url "https://github.com/$REPO" \
      --token "$TOKEN" \
      --name "$RUNNER_NAME" \
      --labels "$RUNNER_LABEL" \
      --ephemeral \
      --disableupdate; then
    echo "[WORKER] Runner registration failed"
    curl -fsS -X POST \
      -H "Authorization: Bearer $WORKER_SECRET" \
      -H "Content-Type: application/json" \
      "$CONTROLLER/internal/done" -d '{}' >/dev/null 2>&1 || true
    cleanup_job
    sleep 5
    continue
  fi

  echo "[WORKER] Runner registered; waiting for GitHub job"
  set +e
  ./run.sh
  RUNNER_EXIT_CODE=$?
  set -e
  echo "[WORKER] Runner exited with code $RUNNER_EXIT_CODE"

  curl -fsS -X POST \
    -H "Authorization: Bearer $WORKER_SECRET" \
    -H "Content-Type: application/json" \
    "$CONTROLLER/internal/done" -d '{}' >/dev/null 2>&1 || true

  cleanup_job
  echo "[WORKER] Job cycle complete"
  sleep 1
done
`;

  const unit = `[Unit]
Description=Leviro CI Shared Worker
After=network-online.target docker.service
Wants=network-online.target
Requires=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/leviro-ci-worker.sh
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;

  return `#cloud-config
write_files:
  - path: /usr/local/bin/leviro-ci-worker.sh
    permissions: '0700'
    encoding: b64
    content: ${Buffer.from(workerScript).toString("base64")}
  - path: /etc/systemd/system/leviro-ci-worker.service
    permissions: '0644'
    encoding: b64
    content: ${Buffer.from(unit).toString("base64")}
runcmd:
  - systemctl daemon-reload
  - systemctl enable leviro-ci-worker.service
  - systemctl start leviro-ci-worker.service
`;
}

async function scw(args) {
  return execFileAsync("scw", args, {
    env: process.env,
    maxBuffer: SCW_MAX_BUFFER,
  });
}

function normalizePowerState(value) {
  const text = String(value || "unknown").toLowerCase();
  if (text.includes("stopped")) return "stopped";
  if (text.includes("running") || text.includes("booted")) return "running";
  if (text.includes("starting")) return "starting";
  if (text.includes("stopping")) return "stopping";
  return text || "unknown";
}

async function getWorkerPowerState(serverId) {
  try {
    const { stdout } = await scw([
      "-o",
      "json",
      "instance",
      "server",
      "get",
      serverId,
      `zone=${ZONE}`,
    ]);
    const parsed = JSON.parse(stdout);
    const server = parsed.server || parsed;
    return normalizePowerState(server.state || server.state_detail);
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    if (output.includes("not found") || output.includes("404")) return "missing";
    throw error;
  }
}

async function waitForPowerState(serverId, target) {
  const deadline = Date.now() + POWER_TRANSITION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await getWorkerPowerState(serverId);
    if (current === target || current === "missing") return current;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for worker ${serverId} to become ${target}`);
}

async function listWorkerInstances() {
  const { stdout } = await scw([
    "-o",
    "json",
    "instance",
    "server",
    "list",
    `zone=${ZONE}`,
  ]);
  const parsed = JSON.parse(stdout);
  const servers = Array.isArray(parsed) ? parsed : parsed.servers || [];
  return servers.filter(
    (server) =>
      server.name === WORKER_NAME &&
      Array.isArray(server.tags) &&
      server.tags.includes("shared-worker"),
  );
}

async function createWorkerInstance() {
  const cloudInit = createWorkerCloudInit();
  const tmpFile = path.join(os.tmpdir(), `leviro-ci-worker-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, cloudInit, { mode: 0o600 });

  try {
    const { stdout } = await scw([
      "-o",
      "json",
      "instance",
      "server",
      "create",
      `zone=${ZONE}`,
      "image=ubuntu_noble",
      `type=${INSTANCE_TYPE}`,
      `name=${WORKER_NAME}`,
      "ip=new",
      "dynamic-ip-required=true",
      "tags.0=leviro-ci",
      "tags.1=shared-worker",
      `cloud-init=@${tmpFile}`,
    ]);

    const data = JSON.parse(stdout);
    const serverId = data.id || data.server?.id;
    if (!serverId) throw new Error(`Scaleway did not return server ID: ${stdout}`);
    return serverId;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

async function startWorkerInstance(serverId) {
  console.log(`[CI] Powering on worker ${serverId}`);
  await scw(["instance", "server", "start", serverId, `zone=${ZONE}`]);
  const result = await waitForPowerState(serverId, "running");
  if (result === "missing") throw new Error(`Worker ${serverId} disappeared while starting`);
  console.log(`[CI] Worker ${serverId} powered on`);
}

async function stopWorkerInstance(serverId) {
  console.log(`[CI] Powering off worker ${serverId}`);
  await scw(["instance", "server", "stop", serverId, `zone=${ZONE}`]);
  const result = await waitForPowerState(serverId, "stopped");
  if (result === "missing") throw new Error(`Worker ${serverId} disappeared while stopping`);
  console.log(`[CI] Worker ${serverId} powered off; disk and IPv4 retained`);
}

function makeWorkerState(serverId, powerState = "running") {
  return {
    serverId,
    createdAt: Date.now(),
    powerState,
    busy: false,
    dispatchRepo: null,
    currentJobId: null,
    currentRepo: null,
    idleSince: powerState === "running" ? Date.now() : null,
  };
}

async function discoverOrReconcileWorker() {
  if (state.worker?.serverId) {
    const powerState = await getWorkerPowerState(state.worker.serverId);
    if (powerState !== "missing") {
      state.worker.powerState = powerState;
      if (powerState === "stopped") {
        state.worker.busy = false;
        state.worker.dispatchRepo = null;
        state.worker.currentJobId = null;
        state.worker.currentRepo = null;
        state.worker.idleSince = null;
      }
      saveState();
      return;
    }

    console.warn(`[CI] Saved worker ${state.worker.serverId} no longer exists; clearing state`);
    state.worker = null;
    saveState();
  }

  const existing = await listWorkerInstances();
  if (existing.length === 0) return;

  if (existing.length > 1) {
    console.warn(
      `[CI] Found ${existing.length} persistent workers; adopting ${existing[0].id}. Remove extras manually.`,
    );
  }

  const server = existing[0];
  state.worker = makeWorkerState(server.id, normalizePowerState(server.state));
  saveState();
  console.log(`[CI] Adopted existing worker ${server.id} (${state.worker.powerState})`);
}

async function ensureWorkerAvailable() {
  if (state.queue.length === 0 || workerTransitioning) return;

  workerTransitioning = true;
  try {
    if (!state.worker) {
      const existing = await listWorkerInstances();
      if (existing.length > 0) {
        const server = existing[0];
        state.worker = makeWorkerState(server.id, normalizePowerState(server.state));
        saveState();
        console.log(`[CI] Reusing existing worker ${server.id} (${state.worker.powerState})`);
      } else {
        console.log(`[CI] Creating persistent Scaleway worker. Queue=${state.queue.length}`);
        const serverId = await createWorkerInstance();
        state.worker = makeWorkerState(serverId, "running");
        state.worker.idleSince = null;
        saveState();
        console.log(`[CI] Persistent worker created: ${serverId}`);
        return;
      }
    }

    const actualState = await getWorkerPowerState(state.worker.serverId);
    if (actualState === "missing") {
      console.warn(`[CI] Worker ${state.worker.serverId} is missing; recreating`);
      state.worker = null;
      saveState();
      return;
    }

    state.worker.powerState = actualState;
    state.worker.idleSince = null;
    saveState();

    if (actualState === "stopped") {
      state.worker.powerState = "starting";
      saveState();
      await startWorkerInstance(state.worker.serverId);
      state.worker.powerState = "running";
      state.worker.busy = false;
      state.worker.dispatchRepo = null;
      state.worker.currentJobId = null;
      state.worker.currentRepo = null;
      state.worker.idleSince = null;
      saveState();
    }
  } catch (error) {
    console.error("[CI] Failed to ensure worker is available:", error);
  } finally {
    workerTransitioning = false;
    if (state.queue.length > 0 && !state.worker) {
      setTimeout(() => ensureWorkerAvailable().catch(console.error), 2_000);
    }
  }
}

function removeQueuedJob(jobId) {
  const before = state.queue.length;
  state.queue = state.queue.filter((item) => String(item.jobId) !== String(jobId));
  return before !== state.queue.length;
}

function isManagedWorkflowJob(payload) {
  const labels = payload.workflow_job?.labels;
  return (
    Array.isArray(labels) &&
    labels.includes("self-hosted") &&
    labels.includes(RUNNER_LABEL)
  );
}

async function handleQueued(payload) {
  const job = payload.workflow_job;
  const jobId = String(job.id);

  const duplicate = state.queue.some((item) => String(item.jobId) === jobId);
  if (duplicate || String(state.worker?.currentJobId || "") === jobId) return;

  state.queue.push({
    jobId,
    repoFullName: payload.repository.full_name,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    installationId: payload.installation.id,
    queuedAt: Date.now(),
  });

  if (state.worker) state.worker.idleSince = null;
  saveState();

  console.log(
    `[CI] Queued ${payload.repository.full_name} job ${jobId}. Queue=${state.queue.length}`,
  );
  await ensureWorkerAvailable();
}

function handleInProgress(payload) {
  const jobId = String(payload.workflow_job.id);
  removeQueuedJob(jobId);

  if (state.worker) {
    state.worker.powerState = "running";
    state.worker.busy = true;
    state.worker.dispatchRepo = null;
    state.worker.currentJobId = jobId;
    state.worker.currentRepo = payload.repository.full_name;
    state.worker.idleSince = null;
  }
  saveState();

  console.log(
    `[CI] Running ${payload.repository.full_name} job ${jobId}. Queue=${state.queue.length}`,
  );
}

function handleCompleted(payload) {
  const jobId = String(payload.workflow_job.id);
  removeQueuedJob(jobId);

  if (state.worker && String(state.worker.currentJobId || "") === jobId) {
    state.worker.busy = false;
    state.worker.dispatchRepo = null;
    state.worker.currentJobId = null;
    state.worker.currentRepo = null;
    state.worker.idleSince = Date.now();
  }
  saveState();
  console.log(`[CI] Completed job ${jobId}. Queue=${state.queue.length}`);
}

async function handleWorkflowJob(payload) {
  const job = payload.workflow_job;
  if (!isManagedWorkflowJob(payload)) {
    console.log(
      `[CI] Ignoring ${payload.action} ${payload.repository.full_name} job ${job?.id ?? "unknown"}. Labels=${JSON.stringify(job?.labels ?? [])}`,
    );
    return;
  }

  switch (payload.action) {
    case "queued":
      await handleQueued(payload);
      break;
    case "in_progress":
      handleInProgress(payload);
      break;
    case "completed":
      handleCompleted(payload);
      break;
    default:
      break;
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "leviro-ci-controller",
    queuedJobs: state.queue.length,
    queue: state.queue.map((job) => ({
      jobId: job.jobId,
      repo: job.repoFullName,
      queuedForSeconds: Math.round((Date.now() - job.queuedAt) / 1000),
    })),
    worker: state.worker
      ? {
          serverId: state.worker.serverId,
          powerState: state.worker.powerState || "unknown",
          busy: state.worker.busy,
          dispatchRepo: state.worker.dispatchRepo,
          currentJobId: state.worker.currentJobId,
          currentRepo: state.worker.currentRepo,
          createdAt: state.worker.createdAt,
          idleSince: state.worker.idleSince,
        }
      : null,
  });
});

app.post("/internal/next", express.json(), async (req, res) => {
  if (!verifyWorker(req)) return res.sendStatus(401);
  if (!state.worker) return res.json({ task: null, waitSeconds: 3 });

  state.worker.powerState = "running";

  if (state.worker.busy || state.queue.length === 0) {
    if (!state.worker.busy && state.queue.length === 0 && !state.worker.idleSince) {
      state.worker.idleSince = Date.now();
      saveState();
    }
    return res.json({ task: null, waitSeconds: 3 });
  }

  const item = state.queue[0];
  state.worker.busy = true;
  state.worker.dispatchRepo = item.repoFullName;
  state.worker.currentJobId = null;
  state.worker.currentRepo = null;
  state.worker.idleSince = null;
  saveState();

  try {
    const token = await runnerRegistrationToken({
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
    });
    const runnerName = `scw-${Date.now()}`;

    console.log(`[CI] Dispatching next job for ${item.repoFullName} to shared worker`);
    return res.json({
      task: { repoFullName: item.repoFullName, token, runnerName },
    });
  } catch (error) {
    state.worker.busy = false;
    state.worker.dispatchRepo = null;
    state.worker.currentJobId = null;
    state.worker.currentRepo = null;
    state.worker.idleSince = Date.now();
    saveState();
    console.error(`[CI] Failed creating runner token for ${item.repoFullName}:`, error);
    return res.sendStatus(500);
  }
});

app.post("/internal/done", express.json(), (req, res) => {
  if (!verifyWorker(req)) return res.sendStatus(401);

  if (state.worker) {
    state.worker.powerState = "running";
    state.worker.busy = false;
    state.worker.dispatchRepo = null;
    state.worker.currentJobId = null;
    state.worker.currentRepo = null;
    state.worker.idleSince = Date.now();
    saveState();
  }

  res.sendStatus(204);
});

app.post(
  "/webhooks/github",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const rawBody = req.body;
    if (!verifyGithubSignature(rawBody, req.header("x-hub-signature-256"))) {
      return res.status(401).send("Invalid signature");
    }

    if (req.header("x-github-event") !== "workflow_job") return res.sendStatus(204);

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    res.sendStatus(202);
    handleWorkflowJob(payload).catch((error) =>
      console.error("[CI] Webhook processing failed:", error),
    );
  },
);

setInterval(async () => {
  if (state.queue.length > 0) {
    await ensureWorkerAvailable();
    return;
  }

  if (
    !state.worker ||
    state.worker.busy ||
    workerTransitioning ||
    state.worker.powerState === "stopped" ||
    state.worker.powerState === "stopping"
  ) {
    return;
  }

  if (!state.worker.idleSince) {
    state.worker.idleSince = Date.now();
    saveState();
    return;
  }

  if (Date.now() - state.worker.idleSince < IDLE_MS) return;

  workerTransitioning = true;
  const serverId = state.worker.serverId;
  state.worker.powerState = "stopping";
  saveState();

  console.log(
    `[CI] Worker idle for ${Math.round(IDLE_MS / 60000)} minute(s). Powering off ${serverId}`,
  );

  try {
    await stopWorkerInstance(serverId);
    if (state.worker?.serverId === serverId) {
      state.worker.powerState = "stopped";
      state.worker.busy = false;
      state.worker.dispatchRepo = null;
      state.worker.currentJobId = null;
      state.worker.currentRepo = null;
      state.worker.idleSince = null;
      saveState();
    }
  } catch (error) {
    console.error("[CI] Worker power-off failed:", error);
    if (state.worker?.serverId === serverId) {
      try {
        state.worker.powerState = await getWorkerPowerState(serverId);
      } catch {
        state.worker.powerState = "unknown";
      }
      state.worker.idleSince = Date.now();
      saveState();
    }
  } finally {
    workerTransitioning = false;
    if (state.queue.length > 0) await ensureWorkerAvailable();
  }
}, 10_000);

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`[CI] Controller listening on 127.0.0.1:${PORT}`);
  console.log(`[CI] Runner label: ${RUNNER_LABEL}`);
  console.log(`[CI] Worker type: ${INSTANCE_TYPE}`);
  console.log(`[CI] Persistent worker name: ${WORKER_NAME}`);
  console.log(`[CI] Idle power-off: ${Math.round(IDLE_MS / 60000)} minute(s)`);

  try {
    await discoverOrReconcileWorker();
    if (state.queue.length > 0) await ensureWorkerAvailable();
  } catch (error) {
    console.error("[CI] Startup worker reconciliation failed:", error);
  }
});
