import "dotenv/config";

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAppAuth } from "@octokit/auth-app";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 5050);

const ZONE =
  process.env.SCW_DEFAULT_ZONE || "fr-par-1";

const INSTANCE_TYPE =
  process.env.SCW_INSTANCE_TYPE || "DEV1-M";

const RUNNER_LABEL =
  process.env.RUNNER_LABEL || "scaleway-ci";

const CONTROLLER_URL =
  process.env.CONTROLLER_PUBLIC_URL ||
  "https://ci.leviro.net";

const IDLE_MS =
  Number(
    process.env.INSTANCE_IDLE_MINUTES || 3,
  ) *
  60 *
  1000;

const STATE_FILE =
  path.resolve("./data/state.json");

const privateKey = fs.readFileSync(
  process.env.GITHUB_PRIVATE_KEY_PATH,
  "utf8",
);

const app = express();

let workerCreating = false;
let workerDestroying = false;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

function defaultState() {
  return {
    queue: [],
    worker: null,
  };
}

function loadState() {
  try {
    const data = JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        "utf8",
      ),
    );

    return {
      queue: Array.isArray(data.queue)
        ? data.queue
        : [],
      worker: data.worker || null,
    };
  } catch {
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(
    path.dirname(STATE_FILE),
    {
      recursive: true,
    },
  );

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

function verifyGithubSignature(
  rawBody,
  signature,
) {
  if (
    !signature?.startsWith(
      "sha256=",
    )
  ) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac(
        "sha256",
        process.env
          .GITHUB_WEBHOOK_SECRET,
      )
      .update(rawBody)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(
      a,
      b,
    )
  );
}

function verifyWorker(req) {
  const authorization =
    req.header("authorization");

  if (
    !authorization?.startsWith(
      "Bearer ",
    )
  ) {
    return false;
  }

  const supplied =
    authorization.slice(7);

  const expected =
    process.env.WORKER_SECRET;

  if (
    !supplied ||
    !expected
  ) {
    return false;
  }

  const a =
    Buffer.from(supplied);

  const b =
    Buffer.from(expected);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(
      a,
      b,
    )
  );
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

async function githubInstallationToken(
  installationId,
) {
  const auth = createAppAuth({
    appId:
      process.env.GITHUB_APP_ID,
    privateKey,
    installationId,
  });

  const result =
    await auth({
      type: "installation",
    });

  return result.token;
}

async function runnerRegistrationToken({
  installationId,
  owner,
  repo,
}) {
  const installationToken =
    await githubInstallationToken(
      installationId,
    );

  const response =
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runners/registration-token`,
      {
        method: "POST",

        headers: {
          Accept:
            "application/vnd.github+json",

          Authorization:
            `Bearer ${installationToken}`,

          "X-GitHub-Api-Version":
            "2022-11-28",
        },
      },
    );

  if (!response.ok) {
    throw new Error(
      `GitHub registration token failed: ${response.status} ${await response.text()}`,
    );
  }

  const data =
    await response.json();

  return data.token;
}

/* -------------------------------------------------------------------------- */
/* Worker cloud-init                                                          */
/* -------------------------------------------------------------------------- */

function createWorkerCloudInit() {
  const workerScript = `#!/usr/bin/env bash

set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
export RUNNER_ALLOW_RUNASROOT=1

CONTROLLER="${CONTROLLER_URL}"
WORKER_SECRET="${process.env.WORKER_SECRET}"
RUNNER_LABEL="${RUNNER_LABEL}"

exec > >(tee -a /var/log/leviro-ci-worker.log) 2>&1

echo "[WORKER] =========================================="
echo "[WORKER] Leviro CI worker starting"
echo "[WORKER] =========================================="

# ---------------------------------------------------------------------------
# Base packages
# ---------------------------------------------------------------------------

apt-get update

apt-get install -y \\
  ca-certificates \\
  curl \\
  wget \\
  git \\
  jq \\
  zip \\
  unzip \\
  tar \\
  gzip \\
  xz-utils \\
  sudo \\
  gnupg \\
  openssh-client \\
  rsync \\
  build-essential \\
  python3 \\
  python3-pip \\
  pkg-config \\
  gh

# ---------------------------------------------------------------------------
# Docker Engine + Compose + Buildx
# Official Docker repository
# ---------------------------------------------------------------------------

install -m 0755 -d /etc/apt/keyrings

curl -fsSL \\
  https://download.docker.com/linux/ubuntu/gpg \\
  -o /etc/apt/keyrings/docker.asc

chmod a+r /etc/apt/keyrings/docker.asc

ARCH="$(dpkg --print-architecture)"

CODENAME="$(
  . /etc/os-release
  echo "\${UBUNTU_CODENAME:-$VERSION_CODENAME}"
)"

echo \\
  "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \\
  > /etc/apt/sources.list.d/docker.list

apt-get update

apt-get install -y \\
  docker-ce \\
  docker-ce-cli \\
  containerd.io \\
  docker-buildx-plugin \\
  docker-compose-plugin

systemctl enable docker
systemctl start docker

# ---------------------------------------------------------------------------
# Validate baseline
# ---------------------------------------------------------------------------

REQUIRED_COMMANDS=(
  curl
  wget
  git
  jq
  zip
  unzip
  tar
  python3
  gcc
  g++
  make
  gh
  docker
)

for cmd in "\${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[WORKER] ERROR: Missing required command: $cmd"
    exit 1
  fi
done

docker version
docker compose version
docker buildx version

echo "[WORKER] Base dependencies ready"

# ---------------------------------------------------------------------------
# GitHub Actions Runner template
# ---------------------------------------------------------------------------

mkdir -p /opt/actions-runner-template
cd /opt/actions-runner-template

RUNNER_VERSION="$(
  curl -fsSL \\
    https://api.github.com/repos/actions/runner/releases/latest |
  jq -r '.tag_name' |
  sed 's/^v//'
)"

if [ -z "$RUNNER_VERSION" ]; then
  echo "[WORKER] Failed to detect Actions Runner version"
  exit 1
fi

echo "[WORKER] GitHub Actions Runner: $RUNNER_VERSION"

curl -fsSL \\
  -o /tmp/actions-runner.tar.gz \\
  "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"

tar xzf \\
  /tmp/actions-runner.tar.gz

rm -f \\
  /tmp/actions-runner.tar.gz

./bin/installdependencies.sh

echo "[WORKER] Runner template ready"

# ---------------------------------------------------------------------------
# Cleanup function
# ---------------------------------------------------------------------------

cleanup_job() {
  echo "[WORKER] Cleaning previous job"

  rm -rf \\
    /opt/actions-runner-job \\
    /tmp/leviro-ci-* \\
    2>/dev/null || true

  # Kill leftover containers.
  docker ps -aq |
    xargs -r docker rm -f \\
    >/dev/null 2>&1 || true

  # Remove stale networks/volumes.
  docker network prune -f \\
    >/dev/null 2>&1 || true

  docker volume prune -f \\
    >/dev/null 2>&1 || true

  # Keep Docker images/cache intentionally.
  # They can make subsequent jobs faster.
}

cleanup_job

echo "[WORKER] =========================================="
echo "[WORKER] Ready for jobs"
echo "[WORKER] =========================================="

# ---------------------------------------------------------------------------
# Main worker loop
# ---------------------------------------------------------------------------

while true; do

  RESPONSE=""

  if ! RESPONSE="$(
    curl \\
      -fsS \\
      --connect-timeout 10 \\
      --max-time 30 \\
      -X POST \\
      -H "Authorization: Bearer $WORKER_SECRET" \\
      -H "Content-Type: application/json" \\
      "$CONTROLLER/internal/next" \\
      -d '{}'
  )"; then

    echo "[WORKER] Controller unavailable, retrying..."
    sleep 5
    continue
  fi

  HAS_TASK="$(
    echo "$RESPONSE" |
      jq -r '.task != null'
  )"

  if [ "$HAS_TASK" != "true" ]; then

    WAIT_SECONDS="$(
      echo "$RESPONSE" |
        jq -r '.waitSeconds // 3'
    )"

    sleep "$WAIT_SECONDS"
    continue
  fi

  REPO="$(
    echo "$RESPONSE" |
      jq -r '.task.repoFullName'
  )"

  TOKEN="$(
    echo "$RESPONSE" |
      jq -r '.task.token'
  )"

  RUNNER_NAME="$(
    echo "$RESPONSE" |
      jq -r '.task.runnerName'
  )"

  echo "[WORKER] ------------------------------------------"
  echo "[WORKER] Registering runner"
  echo "[WORKER] Repo: $REPO"
  echo "[WORKER] Runner: $RUNNER_NAME"
  echo "[WORKER] ------------------------------------------"

  cleanup_job

  mkdir -p \\
    /opt/actions-runner-job

  cp -a \\
    /opt/actions-runner-template/. \\
    /opt/actions-runner-job/

  cd /opt/actions-runner-job

  if ! ./config.sh \\
      --unattended \\
      --url "https://github.com/$REPO" \\
      --token "$TOKEN" \\
      --name "$RUNNER_NAME" \\
      --labels "$RUNNER_LABEL" \\
      --ephemeral \\
      --disableupdate
  then

    echo "[WORKER] Runner registration failed"

    curl \\
      -fsS \\
      -X POST \\
      -H "Authorization: Bearer $WORKER_SECRET" \\
      -H "Content-Type: application/json" \\
      "$CONTROLLER/internal/done" \\
      -d '{}' \\
      >/dev/null 2>&1 || true

    cleanup_job

    sleep 5
    continue
  fi

  echo "[WORKER] Runner registered"
  echo "[WORKER] Waiting for GitHub job"

  set +e

  ./run.sh

  RUNNER_EXIT_CODE=$?

  set -e

  echo "[WORKER] Runner exited with code: $RUNNER_EXIT_CODE"

  curl \\
    -fsS \\
    -X POST \\
    -H "Authorization: Bearer $WORKER_SECRET" \\
    -H "Content-Type: application/json" \\
    "$CONTROLLER/internal/done" \\
    -d '{}' \\
    >/dev/null 2>&1 || true

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

  const encodedScript =
    Buffer.from(
      workerScript,
    ).toString("base64");

  const encodedUnit =
    Buffer.from(
      unit,
    ).toString("base64");

  return `#cloud-config
write_files:
  - path: /usr/local/bin/leviro-ci-worker.sh
    permissions: '0700'
    encoding: b64
    content: ${encodedScript}

  - path: /etc/systemd/system/leviro-ci-worker.service
    permissions: '0644'
    encoding: b64
    content: ${encodedUnit}

runcmd:
  - systemctl daemon-reload
  - systemctl enable leviro-ci-worker.service
  - systemctl start leviro-ci-worker.service
`;
}

/* -------------------------------------------------------------------------- */
/* Scaleway                                                                   */
/* -------------------------------------------------------------------------- */

async function createWorkerInstance() {
  const cloudInit =
    createWorkerCloudInit();

  const tmpFile =
    path.join(
      os.tmpdir(),
      `leviro-ci-worker-${Date.now()}.yaml`,
    );

  fs.writeFileSync(
    tmpFile,
    cloudInit,
    {
      mode: 0o600,
    },
  );

  try {
    const { stdout } =
      await execFileAsync(
        "scw",
        [
          "-o",
          "json",

          "instance",
          "server",
          "create",

          `zone=${ZONE}`,

          "image=ubuntu_noble",

          `type=${INSTANCE_TYPE}`,

          "name=leviro-ci-worker",

          "ip=new",

          "dynamic-ip-required=true",

          "tags.0=leviro-ci",

          "tags.1=shared-worker",

          `cloud-init=@${tmpFile}`,
        ],
        {
          env: process.env,

          maxBuffer:
            10 *
            1024 *
            1024,
        },
      );

    const data =
      JSON.parse(stdout);

    if (!data.id) {
      throw new Error(
        `Scaleway did not return server ID: ${stdout}`,
      );
    }

    return data.id;
  } finally {
    fs.rmSync(
      tmpFile,
      {
        force: true,
      },
    );
  }
}

async function destroyWorker(
  serverId,
) {
  console.log(
    `[CI] Destroying worker ${serverId}`,
  );

  try {
    await execFileAsync(
      "scw",
      [
        "instance",
        "server",
        "delete",

        serverId,

        `zone=${ZONE}`,

        "force-shutdown=true",

        "with-volumes=all",

        "with-ip=true",
      ],
      {
        env: process.env,

        maxBuffer:
          10 *
          1024 *
          1024,
      },
    );
  } catch (error) {
    const output =
      `${error.stdout || ""}\n${error.stderr || ""}`;

    if (
      output.includes(
        "not found",
      ) ||
      output.includes("404")
    ) {
      return;
    }

    throw error;
  }
}

async function ensureWorker() {
  if (
    state.worker ||
    workerCreating ||
    workerDestroying ||
    state.queue.length === 0
  ) {
    return;
  }

  workerCreating = true;

  try {
    console.log(
      `[CI] Creating shared Scaleway worker. Queue=${state.queue.length}`,
    );

    const serverId =
      await createWorkerInstance();

    state.worker = {
      serverId,

      createdAt:
        Date.now(),

      busy: false,

      dispatchRepo: null,

      currentJobId: null,

      currentRepo: null,

      idleSince: null,
    };

    saveState();

    console.log(
      `[CI] Shared worker created: ${serverId}`,
    );
  } catch (error) {
    console.error(
      "[CI] Worker creation failed:",
      error,
    );
  } finally {
    workerCreating = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

function removeQueuedJob(
  jobId,
) {
  const before =
    state.queue.length;

  state.queue =
    state.queue.filter(
      (item) =>
        String(
          item.jobId,
        ) !==
        String(jobId),
    );

  return (
    before !==
    state.queue.length
  );
}

function isManagedWorkflowJob(
  payload,
) {
  const labels =
    payload.workflow_job
      ?.labels;

  return (
    Array.isArray(labels) &&
    labels.includes(
      "self-hosted",
    ) &&
    labels.includes(
      RUNNER_LABEL,
    )
  );
}

async function handleQueued(
  payload,
) {
  const job =
    payload.workflow_job;

  const jobId =
    String(job.id);

  if (
    !job.labels?.includes(
      RUNNER_LABEL,
    )
  ) {
    return;
  }

  const alreadyQueued =
    state.queue.some(
      (item) =>
        String(
          item.jobId,
        ) === jobId,
    );

  if (
    alreadyQueued ||
    String(
      state.worker
        ?.currentJobId ||
        "",
    ) === jobId
  ) {
    return;
  }

  state.queue.push({
    jobId,

    repoFullName:
      payload.repository
        .full_name,

    owner:
      payload.repository
        .owner.login,

    repo:
      payload.repository.name,

    installationId:
      payload.installation.id,

    queuedAt:
      Date.now(),
  });

  if (
    state.worker &&
    !state.worker.busy
  ) {
    state.worker.idleSince =
      null;
  }

  saveState();

  console.log(
    `[CI] Queued ${payload.repository.full_name} job ${jobId}. Queue=${state.queue.length}`,
  );

  await ensureWorker();
}

function handleInProgress(
  payload,
) {
  const job =
    payload.workflow_job;

  const jobId =
    String(job.id);

  removeQueuedJob(jobId);

  if (state.worker) {
    state.worker.busy =
      true;

    state.worker.dispatchRepo =
      null;

    state.worker.currentJobId =
      jobId;

    state.worker.currentRepo =
      payload.repository
        .full_name;

    state.worker.idleSince =
      null;
  }

  saveState();

  console.log(
    `[CI] Running ${payload.repository.full_name} job ${jobId}. Queue=${state.queue.length}`,
  );
}

function handleCompleted(
  payload,
) {
  const jobId =
    String(
      payload.workflow_job.id,
    );

  removeQueuedJob(jobId);

  if (
    state.worker &&
    String(
      state.worker
        .currentJobId ||
        "",
    ) === jobId
  ) {
    state.worker.busy =
      false;

    state.worker.dispatchRepo =
      null;

    state.worker.currentJobId =
      null;

    state.worker.currentRepo =
      null;

    state.worker.idleSince =
      Date.now();
  }

  saveState();

  console.log(
    `[CI] Completed job ${jobId}. Queue=${state.queue.length}`,
  );
}

async function handleWorkflowJob(
  payload,
) {
  const job =
    payload.workflow_job;

  if (
    !isManagedWorkflowJob(
      payload,
    )
  ) {
    console.log(
      `[CI] Ignoring ${payload.action} ${payload.repository.full_name} job ${job?.id ?? "unknown"}. Labels=${JSON.stringify(job?.labels ?? [])}`,
    );

    return;
  }

  switch (payload.action) {
    case "queued":
      await handleQueued(
        payload,
      );
      break;

    case "in_progress":
      handleInProgress(
        payload,
      );
      break;

    case "completed":
      handleCompleted(
        payload,
      );
      break;

    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,

      service:
        "leviro-ci-controller",

      queuedJobs:
        state.queue.length,

      queue:
        state.queue.map(
          (job) => ({
            jobId:
              job.jobId,

            repo:
              job.repoFullName,

            queuedForSeconds:
              Math.round(
                (
                  Date.now() -
                  job.queuedAt
                ) /
                  1000,
              ),
          }),
        ),

      worker:
        state.worker
          ? {
              serverId:
                state.worker
                  .serverId,

              busy:
                state.worker
                  .busy,

              dispatchRepo:
                state.worker
                  .dispatchRepo,

              currentJobId:
                state.worker
                  .currentJobId,

              currentRepo:
                state.worker
                  .currentRepo,

              createdAt:
                state.worker
                  .createdAt,

              idleSince:
                state.worker
                  .idleSince,
            }
          : null,
    });
  },
);

/* -------------------------------------------------------------------------- */
/* Worker API                                                                 */
/* -------------------------------------------------------------------------- */

app.post(
  "/internal/next",
  express.json(),
  async (req, res) => {
    if (
      !verifyWorker(req)
    ) {
      return res.sendStatus(
        401,
      );
    }

    if (!state.worker) {
      return res.json({
        task: null,
        waitSeconds: 3,
      });
    }

    if (
      state.worker.busy ||
      state.queue.length === 0
    ) {
      return res.json({
        task: null,
        waitSeconds: 3,
      });
    }

    /*
     * We only select the repository here.
     *
     * GitHub decides which queued job from that repo
     * is assigned to the ephemeral runner.
     *
     * workflow_job.in_progress is the source of truth
     * for the actual Job ID.
     */

    const item =
      state.queue[0];

    state.worker.busy =
      true;

    state.worker.dispatchRepo =
      item.repoFullName;

    state.worker.currentJobId =
      null;

    state.worker.currentRepo =
      null;

    state.worker.idleSince =
      null;

    saveState();

    try {
      const token =
        await runnerRegistrationToken(
          {
            installationId:
              item.installationId,

            owner:
              item.owner,

            repo:
              item.repo,
          },
        );

      const runnerName =
        `scw-${Date.now()}`;

      console.log(
        `[CI] Dispatching next job for ${item.repoFullName} to shared worker`,
      );

      return res.json({
        task: {
          repoFullName:
            item.repoFullName,

          token,

          runnerName,
        },
      });
    } catch (error) {
      state.worker.busy =
        false;

      state.worker.dispatchRepo =
        null;

      state.worker.currentJobId =
        null;

      state.worker.currentRepo =
        null;

      state.worker.idleSince =
        Date.now();

      saveState();

      console.error(
        `[CI] Failed creating runner token for ${item.repoFullName}:`,
        error,
      );

      return res.sendStatus(
        500,
      );
    }
  },
);

app.post(
  "/internal/done",
  express.json(),
  (req, res) => {
    if (
      !verifyWorker(req)
    ) {
      return res.sendStatus(
        401,
      );
    }

    if (state.worker) {
      state.worker.busy =
        false;

      state.worker.dispatchRepo =
        null;

      state.worker.currentJobId =
        null;

      state.worker.currentRepo =
        null;

      state.worker.idleSince =
        Date.now();

      saveState();
    }

    res.sendStatus(204);
  },
);

/* -------------------------------------------------------------------------- */
/* GitHub webhook                                                             */
/* -------------------------------------------------------------------------- */

app.post(
  "/webhooks/github",

  express.raw({
    type:
      "application/json",
  }),

  (req, res) => {
    const rawBody =
      req.body;

    const valid =
      verifyGithubSignature(
        rawBody,

        req.header(
          "x-hub-signature-256",
        ),
      );

    if (!valid) {
      return res
        .status(401)
        .send(
          "Invalid signature",
        );
    }

    const event =
      req.header(
        "x-github-event",
      );

    if (
      event !==
      "workflow_job"
    ) {
      return res.sendStatus(
        204,
      );
    }

    let payload;

    try {
      payload =
        JSON.parse(
          rawBody.toString(
            "utf8",
          ),
        );
    } catch {
      return res
        .status(400)
        .send(
          "Invalid JSON",
        );
    }

    res.sendStatus(202);

    handleWorkflowJob(
      payload,
    ).catch(
      (error) => {
        console.error(
          "[CI] Webhook processing failed:",
          error,
        );
      },
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Worker lifecycle                                                           */
/* -------------------------------------------------------------------------- */

setInterval(
  async () => {
    /*
     * Queued jobs with no worker:
     * create one.
     */

    if (
      state.queue.length >
        0 &&
      !state.worker
    ) {
      await ensureWorker();
      return;
    }

    /*
     * Never destroy while:
     * - worker doesn't exist
     * - worker is busy
     * - jobs are queued
     * - destroy already running
     */

    if (
      !state.worker ||
      state.worker.busy ||
      state.queue.length >
        0 ||
      workerDestroying
    ) {
      return;
    }

    if (
      !state.worker
        .idleSince
    ) {
      state.worker.idleSince =
        Date.now();

      saveState();

      return;
    }

    if (
      Date.now() -
        state.worker
          .idleSince <
      IDLE_MS
    ) {
      return;
    }

    workerDestroying =
      true;

    const serverId =
      state.worker.serverId;

    console.log(
      `[CI] Worker idle for ${Math.round(IDLE_MS / 60000)} minute(s). Destroying ${serverId}`,
    );

    try {
      await destroyWorker(
        serverId,
      );

      if (
        state.worker
          ?.serverId ===
        serverId
      ) {
        state.worker =
          null;
      }

      saveState();

      console.log(
        `[CI] Worker ${serverId} deleted`,
      );
    } catch (error) {
      console.error(
        "[CI] Worker cleanup failed:",
        error,
      );
    } finally {
      workerDestroying =
        false;

      if (
        state.queue.length >
          0 &&
        !state.worker
      ) {
        await ensureWorker();
      }
    }
  },

  10_000,
);

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

app.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      `[CI] Controller listening on 127.0.0.1:${PORT}`,
    );

    console.log(
      `[CI] Runner label: ${RUNNER_LABEL}`,
    );

    console.log(
      `[CI] Worker type: ${INSTANCE_TYPE}`,
    );

    console.log(
      `[CI] Idle timeout: ${Math.round(IDLE_MS / 60000)} minute(s)`,
    );
  },
);
