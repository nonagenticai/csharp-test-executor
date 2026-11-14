#!/usr/bin/env node

// Dependency-free on purpose: the base image's build_smoke imports this to
// reproduce production's offline-resolution setup inside a container that has
// no node_modules. Importing the service instead would drag in express + the
// shared executor-common package and run their module-level side effects.

/**
 * The NuGet.Config the service writes to $HOME/.nuget/NuGet/NuGet.Config at boot.
 *
 * Hoisted to its own module 2026-08-18 so ONE definition feeds both
 * ensureOfflineNuGetConfig() and the base image's smoke test. The smoke used to
 * `export NUGET_PACKAGES=/opt/nuget-fallback`, which is a DIFFERENT resolution
 * mechanism than production uses -- it makes the baked folder the global
 * packages folder. Production never sets NUGET_PACKAGES; it leaves it at the
 * default and relies on the image's `ENV NUGET_FALLBACK_PACKAGES=/opt/nuget-fallback`
 * plus this config clearing every remote source. Smoking the wrong mechanism
 * meant the real path could break with the smoke still green.
 *
 * Only <clear /> -- no <fallbackPackageFolders>. The fallback folder comes from
 * the NUGET_FALLBACK_PACKAGES environment variable baked into the image, which
 * NuGet reads natively; naming it here too would be a second place to drift.
 */
const OFFLINE_NUGET_CONFIG =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<configuration>\n' +
    '  <packageSources>\n' +
    '    <clear />\n' +
    '  </packageSources>\n' +
    '</configuration>\n';

module.exports = { OFFLINE_NUGET_CONFIG };
