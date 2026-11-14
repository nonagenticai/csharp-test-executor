const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

// ---------------------------------------------------------------------------
// The shipped image is assembled by naming source files ONE BY ONE in COPY
// instructions. On 2026-08-18 #20 split the offline-NuGet config into its own
// module, added the require, and did not add the COPY. The image built green,
// pushed green, and then CrashLooped on boot for ~70 minutes:
//
//   Error: Cannot find module './nuget-config-template'
//     at Object.<anonymous> (/app/csharp_test_service.js:30:34)
//
// Nothing in the pipeline could catch it. The unit suite runs against the repo,
// where the file exists. And ts-service.yml pushes :sha-* AND :latest in ONE
// buildx invocation, so the ImagePolicy (filterTags ^latest$) sees the image
// the moment it is built -- "Wait for Flux rollout" is a detector running after
// publication, not a gate.
//
// This test IS the gate, and it works because `build-test` is a single job:
// test and `docker buildx --push` are sequential steps in it, so a red suite
// stops the image from ever being built. It also runs on both the PR and the
// main push, so it survives the concurrency eviction that hid #20's own run.
//
// java-test-executor shipped the same guard after the identical bug (its #13,
// `Cannot find module './pom-template'`). Two occurrences in seven repos in two
// months. This copy differs deliberately in three ways:
//   - the walk is TRANSITIVE, not depth-1: java's version would miss a require
//     nested inside a required module. Free today (the graph is depth-1) and it
//     stops the guard from being one refactor away from vacuous.
//   - an unresolvable require FAILS LOUDLY rather than being skipped. A silent
//     `continue` is how a guard rots into a no-op.
//   - no /opt/bake-src exclusion: the NuGet bake moved to Dockerfile.base in
//     #17, so filtering for a line that does not exist is dead code.
// ---------------------------------------------------------------------------

const ENTRYPOINT = 'csharp_test_service.js';

/** Every local module reachable from the entrypoint, transitively. */
function collectLocalModules(entry) {
    const srcDir = path.join(repoRoot, 'src');
    const found = new Set();
    const queue = [entry];
    const visited = new Set();

    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);

        const abs = path.join(srcDir, current);
        if (!fs.existsSync(abs)) {
            // LOUD. A require we cannot resolve means either the file is missing
            // from the repo or this resolver is wrong -- both must stop the suite,
            // because silently skipping is indistinguishable from "all clear".
            throw new Error(
                `cannot resolve required module "${current}" under src/ ` +
                    `(reached from ${ENTRYPOINT}). Either the file is missing or ` +
                    `this test's resolver needs updating -- do not skip it.`
            );
        }

        const source = fs.readFileSync(abs, 'utf8');
        // Relative requires only -- bare specifiers come from npm install.
        for (const m of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
            const rel = m[1].replace(/^\.\//, '');
            const file = rel.endsWith('.js') ? rel : `${rel}.js`;
            found.add(file);
            queue.push(file);
        }
    }
    return [...found];
}

describe('every local module the service requires is COPYed into the image', () => {
    const localModules = collectLocalModules(ENTRYPOINT);

    const copyLines = dockerfile
        .split('\n')
        .filter((l) => l.trim().startsWith('COPY '));

    test('the scan found the requires it is supposed to guard (non-vacuity)', () => {
        // If this drops to zero the rest of the suite silently checks nothing.
        expect(localModules.length).toBeGreaterThan(0);
        expect(localModules).toContain('nuget-config-template.js');
    });

    test.each(localModules)('`require("./%s")` has a matching COPY', (file) => {
        // The COPY may name the file alone or as one source of a multi-source COPY.
        const copiesIntoApp = copyLines.some((l) => l.includes(`src/${file}`));
        expect(copiesIntoApp).toBe(true);
    });

    test('the entrypoint itself is copied', () => {
        expect(copyLines.some((l) => l.includes(`src/${ENTRYPOINT}`))).toBe(true);
    });
});
