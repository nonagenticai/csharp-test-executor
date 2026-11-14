# syntax=docker/dockerfile:1.7
#
# C# Test Executor — ONE image, two stages.
#
# This was a two-image chain: Dockerfile.base built `csharp-test-executor-base` into the estate's
# private registry and the app pinned it by digest. For the public repository the chain is folded
# into a single build — `toolchain` is the old base (.NET SDK + node for the service), `app` is the
# service. One artefact to publish, nothing to pin.
FROM docker.io/library/node:26-alpine AS nodebase

FROM docker.io/dotnet/sdk:8.0-alpine AS toolchain

COPY --from=nodebase /usr/local/bin/node /usr/local/bin/node
COPY --from=nodebase /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# libatomic: node 26's amd64 binary needs libatomic.so.1, which the dotnet alpine
# base does not ship. Without it the binary fails at exec with
#   Error relocating /usr/local/bin/node: __atomic_compare_exchange: symbol not found
# (measured 2026-11-06, amd64 build of this file; node 24 did not need it).
RUN apk add --no-cache curl bash libatomic

# ── Offline NuGet fallback ───────────────────────────────────────────────────
# The runtime namespace has ZERO internet egress, so without this every
# /execute dies resolving xunit/nunit/mstest from nuget.org. The FATAL guards
# are load-bearing: a bake that silently produced an empty folder would ship an
# executor that cannot scaffold offline, and the failure would only appear in
# production.
ENV NUGET_FALLBACK_PACKAGES=/opt/nuget-fallback
RUN mkdir -p /opt/nuget-fallback /tmp/nuget-bake \
 && cd /tmp/nuget-bake \
 && export DOTNET_CLI_TELEMETRY_OPTOUT=1 NUGET_PACKAGES=/opt/nuget-fallback \
 && for t in xunit nunit mstest classlib console; do \
        dotnet new "$t" -n "Bake_$t" --framework net8.0 >/dev/null \
     && dotnet restore "Bake_$t/Bake_$t.csproj" >/dev/null \
     || { echo "FATAL: baking $t failed — the image would ship an executor that cannot scaffold $t offline" >&2; exit 1; }; \
    done \
 && rm -rf /tmp/nuget-bake \
 && chmod -R a+rX /opt/nuget-fallback \
 && test -d /opt/nuget-fallback/xunit || { echo "FATAL: fallback folder is empty after bake" >&2; exit 1; }

# ── Application ──────────────────────────────────────────────────────────────
FROM toolchain AS app


WORKDIR /app

COPY src/package.json src/package-lock.json ./
RUN npm ci && npm cache clean --force

# Source files are named ONE BY ONE on purpose (a `src/*.js` glob does not
# recurse, so it would silently miss a future src/lib/foo.js while LOOKING
# immune). That means this list must grow whenever src/ does.
# It did not on 2026-08-18: #20 added nuget-config-template.js and its
# require, the image shipped without it, and the container CrashLooped on
# `Cannot find module './nuget-config-template'`.
# tests/unit/dockerfile-copies-modules.test.js now fails the build if a
# reachable require has no COPY -- same guard java-test-executor added
# after the identical bug (its #13).
COPY src/csharp_test_service.js src/nuget-config-template.js src/common.js ./

RUN mkdir -p /app/test_workspace /app/reports

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8090/health || exit 1

CMD ["node", "csharp_test_service.js"]
