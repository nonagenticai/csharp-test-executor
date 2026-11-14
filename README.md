# csharp-test-executor

Executes C# code compilation, unit tests, code coverage, formatting checks, and security scans inside an isolated container. Part of the `code_graph_helper` microservice suite -- called by `coding-testing` to handle all C#/.NET test workloads.

The service is a Node.js (Express) wrapper around the `dotnet` CLI. When a request arrives, it scaffolds a temporary .NET solution with the submitted source and test files, runs `dotnet build` and `dotnet test`, collects results, and tears down the workspace.

## Architecture

```
coding-testing (Python)
  |
  |  POST /execute  (HTTP, port 8090)
  v
csharp-test-executor (Node.js + .NET 8 SDK)
  |
  |  dotnet new / restore / build / test / format / list package
  v
/app/test_workspace/<uuid>/   (ephemeral, deleted after 2 min)
```

**Runtime:** Node.js 18 + .NET 8.0.100 SDK in a single Docker image.

**Supported test frameworks:** xUnit (default), NUnit, MSTest.

## API Routes

### `GET /health`

Health check. Returns service status and declared capabilities.

**Response 200:**
```json
{
  "status": "healthy",
  "service": "csharp-test-executor",
  "timestamp": "...",
  "version": "1.0.0",
  "capabilities": {
    "frameworks": ["xunit", "nunit", "mstest"],
    "features": [
      "test_execution", "code_coverage", "static_analysis",
      "package_scanning", "format_checking", "build_compilation",
      "nuget_management"
    ]
  }
}
```

### `GET /frameworks`

Returns metadata about supported test frameworks, dotnet CLI commands, and target framework versions (`net6.0` through `net8.0`, `netstandard2.0/2.1`).

### `POST /execute`

Primary endpoint. Accepts C# source + test code, scaffolds a .NET solution, builds, runs tests, collects coverage, checks formatting, and scans for vulnerable packages.

**Request body:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | `string` or `{filename: content}` | -- | Source code for the core project. String is written as `Class1.cs`; object keys become filenames. |
| `testCode` | `string` or `{filename: content}` | -- | Test code. String is written as `UnitTest1.cs`. |
| `projectType` | `string` | `"classlib"` | `dotnet new` template for the core project (`classlib`, `console`, etc.). |
| `framework` | `string` | `"xunit"` | Test framework: `xunit`, `nunit`, or `mstest`. |
| `targetFramework` | `string` | `"net8.0"` | .NET TFM for both projects. |
| `dependencies` | `{name: version}` | `{}` | Extra NuGet packages to add to the core project. |
| `options.generateCoverage` | `bool` | `true` | Collect XPlat Code Coverage via coverlet. |
| `options.checkFormatting` | `bool` | `true` | Run `dotnet format --verify-no-changes`. |
| `options.runSecurityScan` | `bool` | `true` | Run `dotnet list package --vulnerable` and `dotnet outdated`. |

At least one of `code` or `testCode` is required.

**Response 200:**
```json
{
  "executionId": "uuid",
  "framework": "xunit",
  "targetFramework": "net8.0",
  "success": true,
  "duration": 12345,
  "restore": { "success": true, "output": "...", "errors": "..." },
  "compilation": { "success": true, "output": "...", "errors": "...", "exitCode": 0 },
  "tests": { "total": 3, "passed": 3, "failed": 0, "skipped": 0, "testResults": [...], "duration": "..." },
  "coverage": { "success": true, "metrics": { "lineRate": "85.00", "branchRate": "70.00", ... } },
  "formatting": { "success": true, "formatted": true },
  "security": { "vulnerablePackages": {...}, "outdatedPackages": {...} }
}
```

`success` is `true` only when the build succeeds, `dotnet test` exits 0, **at least one
test actually passed**, and zero tests failed. A run in which every test was skipped
(`[Fact(Skip="...")]`) is therefore **not** a success -- no test body ran.

**Probe payload:** a request whose `code` is exactly `// test` **and** which carries no
`testCode` is an endpoint-existence probe: it returns immediately without invoking
dotnet, in the same response shape as a real run, with
`success: false, skipped: true, noTestsRun: true, reason: "probe_payload"`,
`restore`/`compilation`/`coverage`/`formatting`/`security` all `null`, and all
`tests` counters `0`. Nothing is compiled, so nothing passed. Any request that
supplies `testCode` is a real suite and takes the full dotnet path.

### `POST /validate`

Validates C# syntax by creating a temporary project and running `dotnet build`.

**Request body:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | `string` | -- | C# source code to validate. |
| `projectType` | `string` | `"console"` | `dotnet new` template. |
| `targetFramework` | `string` | `"net8.0"` | .NET TFM. |

**Response 200:**
```json
{
  "validationId": "uuid",
  "valid": true,
  "errors": [],
  "warnings": ["..."],
  "output": "..."
}
```

### `POST /run-command`

Runs an arbitrary `dotnet` CLI command.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | A key from the built-in command map (`build`, `clean`, `restore`, `test`, `testWithCoverage`, `format`, `formatVerify`, `pack`, `publish`) or a raw string starting with `dotnet `. |
| `projectPath` | `string` | Working directory (defaults to `TEST_WORKSPACE`). |
| `arguments` | `string[]` | Additional CLI arguments appended to the command. |

**Response 200:**
```json
{
  "commandId": "uuid",
  "command": "dotnet build ...",
  "success": true,
  "output": "...",
  "errors": "...",
  "exitCode": 0
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | HTTP listen port. |
| `EXECUTION_TIMEOUT` | `300` | Max seconds per shell command before SIGTERM. |
| `TEST_WORKSPACE` | `/app/test_workspace` | Directory for ephemeral project scaffolds. |
| `REPORTS_DIR` | `/app/reports` | Directory for report output (created but not actively used). |
| `TEST_MODE` | -- | Set in docker-compose; no runtime effect currently. |

## Dependencies

**Upstream (calls this service):**
- `coding-testing` -- routes C#/csharp requests to `http://csharp-test-executor:8090` via `CSHARP_TEST_SERVICE_URL`.

**No downstream service dependencies.** The service only shells out to the `dotnet` CLI installed in its own container.

## Docker

```bash
# Build
docker compose build

# Run
docker compose up -d

# Health check
curl http://localhost:8090/health
```

One multi-stage Dockerfile: the `toolchain` stage is `dotnet/sdk:8.0-alpine` plus `curl`, `bash`, `libatomic` and the node binary the service runs on; the `app` stage is the service. (It used to be a separately published base image pinned by digest — folded into one artefact for the public repository.)

## CI/CD

GitHub Actions (`.github/workflows/ci.yml` → `nonagenticai/ci-workflows`'s public `node-service.yml` archetype) on GitHub-hosted runners:
1. Secret scan and private-infrastructure scan
2. `npm ci`, eslint, the jest suite
3. Image build and a `/health` smoke against it
4. From `main`: push `sha-<commit>` + `latest` to `ghcr.io/nonagenticai/csharp-test-executor` with a SLSA provenance attestation

There is no deploy job: this service is retired from the estate's cluster, and the repository is published so its tests, image build and job contract stay reproducible.
