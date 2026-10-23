# Jenkins CI setup

This repository is flattened so `docker-compose.yml`, `Jenkinsfile`, `gateway/`,
`limiter-service/`, `backend-mock/`, and `dashboard/` are at the repository root.

## Jenkins prerequisites
- Jenkins agent with Git, Node.js/npm, Docker Engine, and Docker Compose v2 available on PATH.
- Configure the Jenkins job as **Pipeline script from SCM**, point it at this repository, and set the script path to `Jenkinsfile`.
- The Jenkins agent user must be allowed to run Docker commands.

The pipeline installs locked npm dependencies, checks JavaScript syntax, validates Compose configuration, and builds the service images. It does not deploy or start the services.

## Run locally
```bash
npm --version
docker compose config --quiet
docker compose build
```
