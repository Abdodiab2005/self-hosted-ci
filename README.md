# self-hosted-ci

Leviro's on-demand GitHub Actions controller for a persistent Scaleway worker.

## Lifecycle

The controller listens for GitHub `workflow_job` webhooks for jobs labelled:

```yaml
runs-on: [self-hosted, scaleway-ci]
```

It keeps one Scaleway `DEV1-M` worker and processes queued jobs sequentially:

```text
job queued
  -> create the worker once (or power on the existing worker)
  -> register an ephemeral GitHub runner for the target repository
  -> run one job
  -> clean the workspace/containers
  -> repeat until the queue is empty
  -> wait for the idle timeout
  -> power off the Instance

next job
  -> power on the same Instance
  -> continue using the existing disk, toolchain and caches
```

The Instance is **not deleted on idle**. Its disk and Flexible IPv4 stay attached, while Scaleway compute billing pauses when the Instance is powered off.

## Persistent worker benefits

- Docker, Compose, Buildx, `gh`, `jq`, `zip`, build tools and runner dependencies are installed only when needed.
- GitHub Actions Runner is refreshed when a newer runner release is available.
- Docker images/build cache survive power cycles.
- Job workspaces, containers, networks and unused volumes are cleaned between jobs.
- The controller can adopt an existing `leviro-ci-worker` after a restart or state loss.
- `/health` exposes the queue and worker `powerState`.

## Environment

Copy `.env.example` to `.env` and fill in the secrets. The controller expects the Scaleway CLI to be installed on the controller host.

Important values:

- `INSTANCE_IDLE_MINUTES=3` controls when an idle worker is powered off.
- `SCW_WORKER_NAME=leviro-ci-worker` identifies the persistent Instance.
- `WORKER_SECRET` authenticates the worker to the controller's internal endpoints.

## Run

```bash
npm install
npm test
npm start
```

For production, the controller is typically run behind Nginx with PM2:

```bash
pm2 start server.js --name ci
pm2 save
```

## State

Runtime state is stored in `data/state.json` and must remain local to the controller. Do not commit `.env`, GitHub App private keys, or runtime state.
