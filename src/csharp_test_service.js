#!/usr/bin/env node

/**
 * C# Test Execution Service
 *
 * Node.js wrapper around the dotnet CLI. Scaffolds ephemeral .NET solutions
 * from submitted source/test code, then runs build, test, coverage, formatting,
 * and security scans. Called by coding-testing for all C#/.NET workloads.
 *
 * Supported frameworks: xUnit, NUnit, MSTest
 * Coverage: coverlet (XPlat Code Coverage)
 * Security: dotnet list package --vulnerable — network-dependent, so it reports
 *           itself as skipped-with-a-reason on the offline runtime rather than
 *           surfacing a raw SDK crash. Same for outdated-package analysis.
 */

const {
    createLogger,
    setupExpress,
    tenantGuard,
    installGracefulShutdown,
} = require('./common');
const { execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
// Dependency-free module, shared verbatim with the base image's build_smoke so the
// smoke exercises THIS config rather than a hand-copied one that can rot.
const { OFFLINE_NUGET_CONFIG } = require('./nuget-config-template');

// Configuration
const PORT = process.env.PORT || 8090;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || '300') * 1000; // 5 minutes for .NET builds
const TEST_WORKSPACE = process.env.TEST_WORKSPACE || '/app/test_workspace';
const REPORTS_DIR = process.env.REPORTS_DIR || '/app/reports';

// Initialize Express app with shared setup + orchestrator-only tenant guard
const app = setupExpress({ jsonLimit: '50mb' });
app.use(tenantGuard());

// Logging utility
const log = createLogger();

// Supported testing frameworks
const SUPPORTED_FRAMEWORKS = {
    'xunit': {
        name: 'xUnit',
        packageReference: 'xunit',
        testAdapterPackage: 'xunit.runner.visualstudio',
        attributes: ['Fact', 'Theory'],
        testCommand: 'dotnet test'
    },
    'nunit': {
        name: 'NUnit',
        packageReference: 'NUnit',
        testAdapterPackage: 'NUnit3TestAdapter',
        attributes: ['Test', 'TestCase'],
        testCommand: 'dotnet test'
    },
    'mstest': {
        name: 'MSTest',
        packageReference: 'MSTest.TestFramework',
        testAdapterPackage: 'MSTest.TestAdapter',
        attributes: ['TestMethod', 'DataTestMethod'],
        testCommand: 'dotnet test'
    }
};

// .NET CLI commands
const DOTNET_COMMANDS = {
    build: 'dotnet build',
    clean: 'dotnet clean',
    restore: 'dotnet restore',
    test: 'dotnet test',
    testWithCoverage: 'dotnet test --collect:"XPlat Code Coverage"',
    format: 'dotnet format',
    formatVerify: 'dotnet format --verify-no-changes',
    pack: 'dotnet pack',
    publish: 'dotnet publish'
};

/**
 * Write a user-level NuGet.Config that clears every package source.
 *
 * The runtime namespace has ZERO internet egress (NetworkPolicy default-restrict),
 * so every `dotnet new <test-template>` and `dotnet restore` reached out to
 * api.nuget.org and sat there until it timed out. Measured in a --network none
 * container: 42.4s per scaffold with sources configured, 3.9s with them cleared —
 * the packages themselves come from the baked NUGET_FALLBACK_PACKAGES folder
 * either way, so the network round trip only ever bought latency.
 *
 * $HOME/.nuget/NuGet/NuGet.Config is the ONLY path that works: /etc/NuGet was
 * measured to be ignored by this SDK (`dotnet nuget list source` still listed
 * nuget.org), so this cannot be baked into the image as a file — it has to be
 * written at boot, into the writable HOME the Deployment provides.
 *
 * Deliberately a no-op when NUGET_FALLBACK_PACKAGES is unset: without a baked
 * package folder, clearing the sources would turn a working online environment
 * (a developer laptop, a CI container) into a broken offline one.
 */
async function ensureOfflineNuGetConfig({ home = process.env.HOME, fallback = process.env.NUGET_FALLBACK_PACKAGES } = {}) {
    if (!fallback || !home) return { written: false, reason: 'no NUGET_FALLBACK_PACKAGES' };
    const dir = path.join(home, '.nuget', 'NuGet');
    const file = path.join(dir, 'NuGet.Config');
    try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, OFFLINE_NUGET_CONFIG);
        return { written: true, path: file };
    } catch (error) {
        // Not fatal: restore still succeeds from the fallback folder, it just pays
        // the dead network timeout. Loud, because slow-and-mysterious is worse than
        // slow-and-explained.
        log.warn(`Could not write offline NuGet.Config at ${file}`, { error: error.message });
        return { written: false, reason: error.message };
    }
}

/**
 * Package-analysis (security) helpers.
 *
 * BOTH advertised package analyses are NETWORK operations. `dotnet list package
 * --vulnerable` needs a source to fetch the vulnerability database from, and
 * `dotnet outdated` needs a source to ask "what is the newest version?". The
 * runtime namespace has ZERO internet egress, and ensureOfflineNuGetConfig()
 * deliberately clears every package source on top of that — so neither can
 * produce an answer in production. What they were doing instead:
 *
 *   security.vulnerablePackages.errors -> "Attempted to divide by zero."
 *   security.outdatedPackages.errors   -> "dotnet-outdated does not exist"
 *
 * The first is the SDK's own DivideByZeroException: NuGet's list-package runner
 * divides by the number of configured sources when it partitions the audit
 * across them, and `<clear />` makes that count zero. It is not arithmetic in
 * this service and cannot be fixed here — it can only be avoided by not asking
 * an offline SDK for online data. The second is a `dotnet-outdated-tool` global
 * tool that is not installed in the image (see Dockerfile.base) and deliberately
 * is not being installed: with no egress it would fail exactly the same way, one
 * layer deeper. Both now degrade to an explicit skip with a stated reason.
 *
 * Neither is skipped when sources ARE available (developer laptop, online CI) —
 * the same condition ensureOfflineNuGetConfig() uses to decide whether it
 * cleared the sources in the first place.
 */
function isOfflineNuGet({ fallback = process.env.NUGET_FALLBACK_PACKAGES } = {}) {
    return Boolean(fallback);
}

const OFFLINE_PACKAGE_ANALYSIS_REASON =
    'No NuGet package sources are configured (this runtime has no internet egress, ' +
    'so all sources are cleared and packages are restored from the baked offline ' +
    'fallback folder). Package version and vulnerability data can only be answered ' +
    'by a live NuGet feed, so this check cannot run here.';

const MISSING_TOOL_REASON =
    'The `dotnet-outdated` global tool is not installed in this image, and is not ' +
    'installed on purpose: it resolves the newest version of every package from a ' +
    'live NuGet feed, which this runtime cannot reach. Outdated-package analysis is ' +
    'unavailable in this environment.';

const SOURCE_ARITHMETIC_REASON =
    'The .NET SDK crashed with a DivideByZeroException while listing vulnerable ' +
    'packages. This happens when it has no package source to audit against. ' +
    'Vulnerability data cannot be determined without a reachable NuGet feed.';

function commandText(result) {
    return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}

function isDivideByZeroCrash(result) {
    return /divide by zero|DivideByZeroException/i.test(commandText(result));
}

function isMissingToolError(result) {
    return /does not exist|is not recognized|was not found|No executable found/i.test(commandText(result));
}

async function analyzeVulnerablePackages(projectPath, { offline = isOfflineNuGet() } = {}) {
    if (offline) {
        return { success: false, skipped: true, reason: OFFLINE_PACKAGE_ANALYSIS_REASON, output: '', errors: '' };
    }

    const result = await executeCommand(['dotnet', 'list', 'package', '--vulnerable'], { cwd: projectPath });

    if (!result.success && isDivideByZeroCrash(result)) {
        log.warn('Vulnerable-package scan crashed inside the .NET SDK; reporting it as unavailable');
        return {
            success: false,
            skipped: true,
            reason: SOURCE_ARITHMETIC_REASON,
            output: result.stdout,
            errors: result.stderr
        };
    }

    return { success: result.success, output: result.stdout, errors: result.stderr };
}

async function analyzeOutdatedPackages(projectPath, { offline = isOfflineNuGet() } = {}) {
    if (offline) {
        return { success: false, skipped: true, reason: OFFLINE_PACKAGE_ANALYSIS_REASON, output: '', errors: '' };
    }

    const result = await executeCommand(['dotnet', 'outdated'], { cwd: projectPath });

    if (!result.success && isMissingToolError(result)) {
        log.warn('dotnet-outdated is not installed; reporting outdated-package analysis as unavailable');
        return {
            success: false,
            skipped: true,
            reason: MISSING_TOOL_REASON,
            output: result.stdout,
            errors: result.stderr
        };
    }

    return { success: result.success, output: result.stdout, errors: result.stderr };
}

/**
 * Utility function to execute a command with timeout, WITHOUT a shell.
 *
 * `argv` is an argument vector: `['dotnet', 'build', '--no-restore']`. The file is
 * spawned directly, so no element is ever interpreted by /bin/sh — a request field
 * such as `projectType` can at worst reach `dotnet` as one literal argument, never
 * become a second command. This replaced `exec(command)` (a shell string built by
 * interpolation) after CodeQL flagged js/command-line-injection on the
 * request-derived arguments in /execute, /validate and /run-command.
 */
function executeCommand(argv, options = {}) {
    return new Promise((resolve) => {
        const timeout = options.timeout || EXECUTION_TIMEOUT;
        const cwd = options.cwd || TEST_WORKSPACE;
        let isResolved = false;

        if (!Array.isArray(argv) || argv.length === 0) {
            resolve({
                success: false,
                error: 'executeCommand requires a non-empty argv array',
                stdout: '',
                stderr: 'executeCommand requires a non-empty argv array',
                exitCode: 1
            });
            return;
        }

        const [file, ...args] = argv;
        const commandLine = argv.join(' ');

        log.debug(`Executing command: ${commandLine}`, { cwd, timeout });

        // Set up environment for .NET.
        //
        // DOTNET_ROOT and the /root/.dotnet PATH prefix used to be hardcoded here.
        // Both were wrong: this image installs the SDK at /usr/share/dotnet with the
        // driver on PATH at /usr/bin/dotnet, and NOTHING has ever lived in
        // /root/.dotnet. Worse, /root is unusable at runtime — the container has
        // readOnlyRootFilesystem, so anything the toolchain wants to create under
        // $HOME/... fails with "Read-only file system". Inheriting the pod's env
        // instead lets the Deployment point HOME/DOTNET_CLI_HOME/NUGET_PACKAGES at
        // the writable /tmp emptyDir. Honour an explicit DOTNET_ROOT if one is set.
        const env = {
            ...process.env,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1'
        };
        
        const child = execFile(file, args, {
            cwd,
            maxBuffer: 20 * 1024 * 1024, // 20MB buffer
            timeout,
            env
        }, (error, stdout, stderr) => {
            if (isResolved) return;
            isResolved = true;

            if (error) {
                // Don't treat all non-zero exits as failures (tests might fail)
                log.debug(`Command completed with exit code: ${error.code}`, { command: commandLine });
                resolve({
                    success: error.code === 0,
                    stdout,
                    stderr,
                    exitCode: error.code ?? 1
                });
            } else {
                log.debug(`Command completed successfully: ${commandLine}`);
                resolve({
                    success: true,
                    stdout,
                    stderr,
                    exitCode: 0
                });
            }
        });
        
        // Handle timeout
        setTimeout(() => {
            if (!child.killed && !isResolved) {
                isResolved = true;
                child.kill('SIGTERM');
                resolve({
                    success: false,
                    error: 'Command timed out',
                    stdout: '',
                    stderr: 'Command timed out',
                    exitCode: 124,
                    timeout: true
                });
            }
        }, timeout);
    });
}

/**
 * Parse dotnet test output
 */
function parseTestOutput(output) {
    const results = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        testResults: [],
        duration: 0
    };
    
    const lines = output.split('\n');

    // The two VSTest summary dialects are two RENDERINGS OF THE SAME RUN, not two
    // halves of it. Counting both double-counts, so each dialect accumulates into
    // its own tally (one summary line per test assembly) and exactly one tally is
    // adopted at the end. Previously legacy ASSIGNED while modern ACCUMULATED, so
    // output carrying both forms reported total/passed at roughly 2x.
    const empty = () => ({ total: 0, passed: 0, failed: 0, skipped: 0, seen: false });
    const legacy = empty();
    const modern = empty();

    for (const line of lines) {
        // Legacy VSTest summary (older SDKs):
        //   Total tests: 1. Passed: 1. Failed: 0. Skipped: 0.
        const summaryMatch = line.match(/Total tests: (\d+)\. Passed: (\d+)\. Failed: (\d+)\. Skipped: (\d+)/);
        if (summaryMatch) {
            legacy.total += parseInt(summaryMatch[1]);
            legacy.passed += parseInt(summaryMatch[2]);
            legacy.failed += parseInt(summaryMatch[3]);
            legacy.skipped += parseInt(summaryMatch[4]);
            legacy.seen = true;
        }

        // Modern VSTest summary, which is what the shipped SDK actually prints:
        //   Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1, Duration: < 1 ms - X.dll (net8.0)
        //
        // Without this the parser returned total=0 for a run that PASSED, and
        // because results.success requires `tests.total > 0`, a green test run was
        // reported as a failed execution. Observed live 2026-08-16 on the first
        // /execute that ever got as far as running tests:
        //   output: "Passed!  - Failed:     0, Passed:     1, ... Total:     1"
        //   parsed: {"total":0,"passed":0,"failed":0}   -> success:false
        //
        // ACCUMULATES rather than assigns: VSTest prints one summary line per test
        // assembly, so a solution with two test projects would otherwise report
        // only the last one.
        //
        // LEADING WHITESPACE IS ALLOWED (`^\s*`), matching the per-test matcher
        // below. `dotnet test` indents the summary under some verbosity/terminal
        // -logger settings, and a hard `^` anchor there reproduces the exact bug
        // b572089 fixed for a different reason: total=0 on a genuinely green run,
        // which the success rule turns into success:false.
        //
        // ⛔ SUBMITTED CODE CAN FORGE THIS LINE, SO THE ANCHOR IS STRICT.
        //
        // `dotnet test` prints a test's OWN stdout INDENTED under "Standard
        // Output Messages:". Allowing `^\s*` here therefore let a submitted test
        // inflate the tally with nothing but
        //     Console.WriteLine("Passed!  - Failed: 0, Passed: 9, ... Total: 9");
        // An all-skipped run then reported total=10 passed=9 -> success:true:
        // the fabricated pass this parser was rewritten to stop, reachable again
        // and driven by untrusted input. Verified end-to-end through /execute.
        //
        // Rejected alternatives, both bypassable or wrong:
        //   * require a trailing ` - <assembly>.dll` — one more string the
        //     submitted Console.WriteLine can simply include;
        //   * take the LAST match instead of accumulating — breaks multi-assembly
        //     runs, where VSTest emits one real summary per test dll and the
        //     totals must sum (see vstest-summary.test.js).
        //
        // So: a real summary starts at column 0, and anything indented is
        // untrusted echo. The cost is a false NEGATIVE if some future SDK
        // verbosity indents the genuine summary — total=0 -> success:false. That
        // trade is deliberate: for a service whose entire defect history is
        // reporting passes it never ran, failing closed beats failing open. The
        // indentation tolerance was speculative; the forgery is demonstrated.
        //
        // THREE banner words, not two. `dotnet test` prints `Skipped!` when an
        // assembly's run contains no passes and no failures — every test is
        // [Fact(Skip="wip")]:
        //   Skipped UnitTest1.T [1 ms]
        //   Skipped! - Failed:     0, Passed:     0, Skipped:     1, Total:     1
        // Matching only Passed|Failed made that run fall through to the legacy
        // tally (also absent), so the service returned
        // tests:{total:0,passed:0,failed:0,skipped:0} for a run that discovered
        // and skipped 1 test. Observed live 2026-08-18. The VERDICT was already
        // correct (success requires passed > 0, so success:false either way) —
        // this is reporting accuracy, and adding `Skipped` must not change it.
        // `modern.seen` is set here too, otherwise an all-skipped run silently
        // falls back to legacy.
        const modernMatch = line.match(
            /^(?:Passed|Failed|Skipped)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/
        );
        if (modernMatch) {
            // Accumulate: one genuine summary per assembly, totals sum.
            modern.failed += parseInt(modernMatch[1]);
            modern.passed += parseInt(modernMatch[2]);
            modern.skipped += parseInt(modernMatch[3]);
            modern.total += parseInt(modernMatch[4]);
            modern.seen = true;
        }

        // Parse individual test results
        const testMatch = line.match(/^\s*(Passed|Failed|Skipped)\s+(.+?)\s+\[(.+?)\]/);
        if (testMatch) {
            results.testResults.push({
                status: testMatch[1].toLowerCase(),
                name: testMatch[2].trim(),
                duration: testMatch[3],
                success: testMatch[1] === 'Passed'
            });
        }
        
        // Parse duration
        const durationMatch = line.match(/Total time: ([0-9.:]+)/);
        if (durationMatch) {
            results.duration = durationMatch[1];
        }
    }

    // Modern wins when present — it is what the shipped SDK prints; legacy is the
    // fallback for older SDKs. Never the sum of the two.
    const counts = modern.seen ? modern : legacy;
    results.total = counts.total;
    results.passed = counts.passed;
    results.failed = counts.failed;
    results.skipped = counts.skipped;

    return results;
}

/**
 * Parse coverage results from XML
 */
function parseCoverageResults(xmlContent) {
    if (!xmlContent) return null;
    
    try {
        // Simple XML parsing for coverage metrics
        const summaryMatch = xmlContent.match(/<coverage[^>]*line-rate="([^"]*)"[^>]*branch-rate="([^"]*)"/);
        const lineMatch = xmlContent.match(/<counter type="LINE"[^>]*covered="(\d+)"[^>]*missed="(\d+)"/);
        const branchMatch = xmlContent.match(/<counter type="BRANCH"[^>]*covered="(\d+)"[^>]*missed="(\d+)"/);
        
        const coverage = {};
        
        if (summaryMatch) {
            coverage.lineRate = (parseFloat(summaryMatch[1]) * 100).toFixed(2);
            coverage.branchRate = (parseFloat(summaryMatch[2]) * 100).toFixed(2);
        }
        
        if (lineMatch) {
            const covered = parseInt(lineMatch[1]);
            const missed = parseInt(lineMatch[2]);
            coverage.lines = {
                covered,
                missed,
                total: covered + missed,
                percentage: covered + missed > 0 ? ((covered / (covered + missed)) * 100).toFixed(2) : '0.00'
            };
        }
        
        if (branchMatch) {
            const covered = parseInt(branchMatch[1]);
            const missed = parseInt(branchMatch[2]);
            coverage.branches = {
                covered,
                missed,
                total: covered + missed,
                percentage: covered + missed > 0 ? ((covered / (covered + missed)) * 100).toFixed(2) : '0.00'
            };
        }
        
        return coverage;
    } catch (error) {
        log.warn('Error parsing coverage XML', { error: error.message });
        return null;
    }
}

/**
 * Detect testing framework in project file
 */
async function detectTestingFramework(projectPath) {
    try {
        const csprojFiles = (await fs.readdir(projectPath)).filter(f => f.endsWith('.csproj'));
        
        if (csprojFiles.length === 0) {
            return 'xunit'; // Default
        }
        
        const csprojContent = await fs.readFile(path.join(projectPath, csprojFiles[0]), 'utf8');
        
        if (csprojContent.includes('xunit')) {
            return 'xunit';
        } else if (csprojContent.includes('NUnit')) {
            return 'nunit';
        } else if (csprojContent.includes('MSTest')) {
            return 'mstest';
        }
        
        return 'xunit'; // Default to xUnit
    } catch (error) {
        log.warn('Error detecting testing framework, defaulting to xUnit', { error: error.message });
        return 'xunit';
    }
}

// API Routes

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'csharp-test-executor',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        capabilities: {
            frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
            features: [
                'test_execution',
                'code_coverage',
                'static_analysis',
                'package_scanning',
                'format_checking',
                'build_compilation',
                'nuget_management'
            ]
        }
    });
});

/**
 * Execute C# tests
 */
app.post('/execute', async (req, res) => {
    const executionId = crypto.randomUUID();
    const startTime = Date.now();
    
    try {
        // Validate request body
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                executionId,
                success: false,
                error: 'Request body is required',
                duration: Date.now() - startTime
            });
        }
        
        const {
            code,
            testCode,
            projectType = 'classlib',
            framework = 'xunit',
            targetFramework = 'net8.0',
            dependencies = {},
            options = {}
        } = req.body;
        
        // Fast-path for the `// test` PROBE payload used by endpoint-existence
        // checks. It exists only to answer "is /execute wired up?" without paying
        // for a full dotnet scaffold/restore/build/test cycle.
        //
        // It MUST NOT claim tests passed. Nothing here is compiled and nothing is
        // executed, so the honest answer is zero tests run — and by this service's
        // own success rule (compilation.success && executionSuccess && total > 0 &&
        // failed === 0, see the end of this handler) an execution in which no test
        // ran is NOT a success.
        //
        // The old trigger also matched any string under 200 chars containing
        // "class Test" with no dependencies. That is ordinary, legitimate user
        // source — e.g. `public class Test { ... }` plus a real xunit testCode —
        // and it was answered with `passed: 1` having never invoked dotnet. Every
        // downstream caller trusting that number was being told a test suite it
        // never ran was green. That clause is removed: real code takes the real
        // path and is actually compiled and executed.
        //
        // `!testCode` IS LOAD-BEARING. A probe is a request with nothing to run. A
        // caller that sends a placeholder `code` alongside a genuine xUnit
        // `testCode` has a real suite: matching on `code` alone dropped it — exec
        // was never called, the response was 200 with noTestsRun:true and no
        // `error`, and the caller's suite silently never ran. Any request carrying
        // testCode takes the real path.
        const isProbeRequest =
            code && typeof code === 'string' && code.trim() === '// test' && !testCode;

        if (isProbeRequest) {
            // The probe answers in the SAME SHAPE as the full path's `results`
            // object (see the `const results = {...}` below plus the `results.tests`
            // assignment after `dotnet test`), with honest empty/null values. A
            // consumer doing `body.tests.output.includes(...)` or
            // `body.coverage && body.coverage.metrics` must not hit a TypeError
            // just because it probed the endpoint.
            return res.json({
                executionId,
                framework,
                targetFramework,
                startTime: new Date(startTime).toISOString(),
                success: false,
                skipped: true,
                // TWO SPELLINGS ON PURPOSE, and they must always agree.
                // `noTestsRun` is the spelling this path has always emitted and
                // is load-bearing for existing callers; `no_tests_run` is the
                // /execute contract spelling that the python, javascript and go
                // executors emit and that the orchestrator's alias reader looks
                // for first. The full execution path below emits ONLY the
                // snake_case one — see the derivation after the verdict.
                noTestsRun: true,
                no_tests_run: true,
                reason: 'probe_payload',
                // null, exactly as the full path leaves these when it returns before
                // reaching the corresponding step.
                restore: null,
                compilation: null,
                // {...parseTestOutput(''), output, errors, executionSuccess} — the
                // exact key set the full path produces.
                tests: {
                    total: 0,
                    passed: 0,
                    failed: 0,
                    skipped: 0,
                    testResults: [],
                    duration: 0,
                    output: '',
                    errors: '',
                    executionSuccess: false
                },
                coverage: null,
                formatting: null,
                security: null,
                output: 'Probe payload recognised; no restore, compilation, or test execution was performed',
                duration: Date.now() - startTime
            });
        }

        // Validate required fields
        if (!code && !testCode) {
            return res.status(400).json({
                executionId,
                success: false,
                error: 'At least one of code or testCode is required',
                duration: Date.now() - startTime
            });
        }
        
        log.info(`Starting C# test execution: ${executionId}`, {
            framework,
            projectType,
            targetFramework,
            hasDependencies: Object.keys(dependencies).length > 0
        });
        
        // Create unique project directory
        const projectPath = path.join(TEST_WORKSPACE, executionId);
        await fs.mkdir(projectPath, { recursive: true });
        
        // Create solution and projects
        const projectName = `CSharpTest_${executionId.replace(/-/g, '_')}`;
        const coreProjectName = `${projectName}.Core`;
        const testProjectName = `${projectName}.Tests`;
        
        // Scaffolding steps are LOAD-BEARING: if `dotnet new` fails, the project
        // directory it was supposed to create does not exist, and the next thing
        // that happens is fs.writeFile blowing up with
        //   ENOENT ... /CSharpTest_<id>.Core/Class1.cs
        // — a message that points at the source write instead of at the scaffold,
        // and that reads as an application bug. It is not: the real error was
        // "Read-only file system : '/root/.templateengine'" (or NU1301, offline),
        // discarded here because executeCommand resolves rather than throws.
        // Surface the first failure with its own stderr instead.
        const scaffoldSteps = [
            ['solution', ['dotnet', 'new', 'sln', '-n', projectName]],
            ['core project', ['dotnet', 'new', projectType, '-n', coreProjectName, '--framework', targetFramework]],
        ];
        const testTemplate = framework === 'nunit' ? 'nunit' : framework === 'mstest' ? 'mstest' : 'xunit';
        scaffoldSteps.push(['test project', ['dotnet', 'new', testTemplate, '-n', testProjectName, '--framework', targetFramework]]);

        for (const [label, command] of scaffoldSteps) {
            const commandLine = command.join(' ');
            const result = await executeCommand(command, { cwd: projectPath });
            if (!result.success) {
                log.error(`Scaffolding failed (${label}): ${executionId}`, { command: commandLine, exitCode: result.exitCode });
                return res.status(500).json({
                    executionId,
                    success: false,
                    error: `Failed to scaffold ${label}`,
                    command: commandLine,
                    exitCode: result.exitCode,
                    output: result.stdout,
                    errors: result.stderr,
                    duration: Date.now() - startTime
                });
            }
        }

        // Wiring steps. These used to discard their result: executeCommand RESOLVES
        // on failure rather than throwing, so `await` alone reports nothing. A
        // failed `dotnet add ... reference` leaves the test project unable to see
        // the core project, and a build that still succeeds (because the tests
        // never referenced it) reported success:true. Fail loud instead.
        const wiringSteps = [
            ['add core project to solution', ['dotnet', 'sln', 'add', `${coreProjectName}/${coreProjectName}.csproj`]],
            ['add test project to solution', ['dotnet', 'sln', 'add', `${testProjectName}/${testProjectName}.csproj`]],
            ['add project reference', ['dotnet', 'add', `${testProjectName}/${testProjectName}.csproj`, 'reference', `${coreProjectName}/${coreProjectName}.csproj`]],
        ];

        for (const [label, command] of wiringSteps) {
            const commandLine = command.join(' ');
            const result = await executeCommand(command, { cwd: projectPath });
            if (!result.success) {
                log.error(`Project wiring failed (${label}): ${executionId}`, { command: commandLine, exitCode: result.exitCode });
                return res.status(500).json({
                    executionId,
                    success: false,
                    error: `Failed to ${label}`,
                    command: commandLine,
                    exitCode: result.exitCode,
                    output: result.stdout,
                    errors: result.stderr,
                    duration: Date.now() - startTime
                });
            }
        }

        // Write source code
        if (code) {
            const coreProjectPath = path.join(projectPath, coreProjectName);
            const sourceFiles = typeof code === 'string' ? { 'Class1.cs': code } : code;
            
            for (const [fileName, content] of Object.entries(sourceFiles)) {
                await fs.writeFile(path.join(coreProjectPath, fileName), content);
            }
        }
        
        // Write test code
        if (testCode) {
            const testProjectPath = path.join(projectPath, testProjectName);
            const testFiles = typeof testCode === 'string' ? { 'UnitTest1.cs': testCode } : testCode;
            
            for (const [fileName, content] of Object.entries(testFiles)) {
                await fs.writeFile(path.join(testProjectPath, fileName), content);
            }
        }
        
        // Add additional dependencies. A failed `dotnet add package` (typo'd id,
        // yanked version, offline feed) used to be discarded: the build could still
        // succeed against code that does not yet use the package, and the caller
        // got success:true for a run whose declared dependency was never installed.
        for (const [packageName, version] of Object.entries(dependencies)) {
            const command = ['dotnet', 'add', `${coreProjectName}/${coreProjectName}.csproj`, 'package', packageName, '--version', version];
            const commandLine = command.join(' ');
            const result = await executeCommand(command, { cwd: projectPath });
            if (!result.success) {
                log.error(`Dependency install failed: ${executionId}`, { packageName, version, exitCode: result.exitCode });
                return res.status(500).json({
                    executionId,
                    success: false,
                    error: `Failed to add dependency ${packageName}@${version}`,
                    command: commandLine,
                    exitCode: result.exitCode,
                    output: result.stdout,
                    errors: result.stderr,
                    duration: Date.now() - startTime
                });
            }
        }
        
        const results = {
            executionId,
            framework,
            targetFramework,
            startTime: new Date(startTime).toISOString(),
            restore: null,
            compilation: null,
            tests: null,
            coverage: null,
            formatting: null,
            security: null,
            duration: 0,
            success: false,
            // Initialised false so that EVERY early return out of this object —
            // restore failure and build failure below — carries the field with
            // the only answer those paths can honestly give. A failed restore or
            // a failed build is a FAILURE, not a "nothing ran": the runner was
            // never reached, so nothing was discovered and nothing can be said
            // about discovery. Only the derivation after the verdict may raise
            // it, and only on evidence.
            no_tests_run: false
        };
        
        // Step 1: Restore packages
        log.info(`Restoring NuGet packages: ${executionId}`);
        const restoreResult = await executeCommand(['dotnet', 'restore'], { cwd: projectPath });
        
        results.restore = {
            success: restoreResult.success,
            output: restoreResult.stdout,
            errors: restoreResult.stderr
        };
        
        if (!restoreResult.success) {
            results.duration = Date.now() - startTime;
            return res.json(results);
        }
        
        // Step 2: Build the solution
        log.info(`Building C# solution: ${executionId}`);
        const buildResult = await executeCommand(['dotnet', 'build', '--no-restore'], { cwd: projectPath });
        
        results.compilation = {
            success: buildResult.success,
            output: buildResult.stdout,
            errors: buildResult.stderr,
            exitCode: buildResult.exitCode
        };
        
        if (!buildResult.success) {
            results.duration = Date.now() - startTime;
            return res.json(results);
        }
        
        // Step 3: Run tests
        log.info(`Running C# tests: ${executionId}`);
        const testCommand = options.generateCoverage !== false
            ? ['dotnet', 'test', '--no-build', '--collect:XPlat Code Coverage']
            : ['dotnet', 'test', '--no-build'];
            
        const testResult = await executeCommand(testCommand, { cwd: projectPath });
        
        const testResults = parseTestOutput(testResult.stdout + testResult.stderr);
        
        results.tests = {
            ...testResults,
            output: testResult.stdout,
            errors: testResult.stderr,
            executionSuccess: testResult.success
        };
        
        // Step 4: Process coverage results
        if (options.generateCoverage !== false) {
            log.info(`Processing coverage results: ${executionId}`);
            try {
                // Find coverage files
                const testResultsPath = path.join(projectPath, `${testProjectName}`, 'TestResults');
                
                try {
                    const testResultDirs = await fs.readdir(testResultsPath);
                    for (const dir of testResultDirs) {
                        const coveragePath = path.join(testResultsPath, dir, 'coverage.cobertura.xml');
                        try {
                            const coverageXml = await fs.readFile(coveragePath, 'utf8');
                            results.coverage = {
                                success: true,
                                metrics: parseCoverageResults(coverageXml),
                                xmlPath: coveragePath
                            };
                            break;
                        } catch (fileError) {
                            // Try next directory
                            continue;
                        }
                    }
                } catch (dirError) {
                    log.warn('Coverage directory not found', { error: dirError.message });
                }
                
                if (!results.coverage) {
                    results.coverage = {
                        success: false,
                        error: 'Coverage files not found'
                    };
                }
            } catch (coverageError) {
                log.warn(`Coverage processing failed: ${executionId}`, { error: coverageError.message });
                results.coverage = {
                    success: false,
                    error: coverageError.message
                };
            }
        }
        
        // Step 5: Check code formatting
        if (options.checkFormatting !== false) {
            log.info(`Checking code formatting: ${executionId}`);
            try {
                const formatResult = await executeCommand(['dotnet', 'format', '--verify-no-changes', '--verbosity', 'normal'], { cwd: projectPath });
                
                results.formatting = {
                    success: formatResult.success,
                    output: formatResult.stdout,
                    errors: formatResult.stderr,
                    formatted: formatResult.success
                };
            } catch (formatError) {
                results.formatting = {
                    success: false,
                    error: formatError.message
                };
            }
        }
        
        // Step 6: Security analysis
        if (options.runSecurityScan !== false) {
            log.info(`Running security analysis: ${executionId}`);
            try {
                const offline = isOfflineNuGet();

                const vulnerablePackages = await analyzeVulnerablePackages(projectPath, { offline });
                const outdatedPackages = await analyzeOutdatedPackages(projectPath, { offline });

                results.security = {
                    offline,
                    vulnerablePackages,
                    outdatedPackages
                };
            } catch (securityError) {
                results.security = {
                    success: false,
                    error: securityError.message
                };
            }
        }
        
        results.duration = Date.now() - startTime;
        // Require the test command to have exited 0 (executionSuccess) and at
        // least one test to have actually RUN AND PASSED. `dotnet build` already
        // compiles the test project, but `dotnet test` exiting non-zero (test-host
        // crash, "no test is available", unparsed summary) left failed===0 and was
        // silently reported as success.
        //
        // `passed > 0` rather than `total > 0`: a suite where every test is
        // [Fact(Skip="wip")] prints
        //   Passed!  - Failed: 0, Passed: 0, Skipped: 3, Total: 3
        // and exits 0, so total>0 && failed===0 reported success:true with ZERO
        // test bodies executed — the same lie as the removed fast path, in a
        // different costume. `passed` is read straight off the summary line that
        // also supplies skipped/total, so it is the direct evidence that a test
        // body ran and asserted; `total - skipped > 0` is derived and would still
        // be positive for tests that were discovered but never reported an
        // outcome. Zero passed is never a green run.
        results.success =
            results.compilation.success &&
            results.tests.executionSuccess === true &&
            results.tests.passed > 0 &&
            results.tests.failed === 0;

        // ---------------------------------------------------------------------
        // ZERO COLLECTION, reported as its own fact.
        //
        // `success:false` alone collapses three outcomes that demand three
        // different responses from the caller:
        //   1. the suite ran and a test FAILED            -> fix the code
        //   2. restore/build failed, or the test host CRASHED -> fix the setup
        //   3. the runner ran and DISCOVERED NOTHING      -> there is no suite
        // `no_tests_run` names case 3 and only case 3. Before this, case 3 was
        // unreportable on this path: the field existed only on the `// test`
        // probe fast path, so a genuine zero-discovery run was indistinguishable
        // from a red suite.
        //
        // ⛔ EXIT 0 IS NOT AVAILABLE AS A PRECONDITION HERE. pytest has a
        // dedicated exit code (5) for "no tests collected", which is why the
        // python executor can derive this from the exit code alone. `dotnet
        // test` does not: a zero-discovery run exits NON-ZERO (1) and prints
        //   No test is available in /.../X.Tests.dll. Make sure that test
        //   discoverer & executables are registered ...
        // so `tests.executionSuccess` is FALSE in exactly the case this flag
        // exists to report. Requiring exit 0 would pin the flag to false
        // forever — a field that cannot fire is worse than no field, because it
        // reads as "tests did run".
        //
        // So the discriminator is a POSITIVE marker, never the exit code:
        // either the runner's own no-tests diagnostic, or a clean (exit 0) run
        // whose parsed summary counted zero tests. A test host that CRASHED
        // prints neither, so it stays false and is not mislabelled "you have no
        // tests" — that is the case-2-vs-case-3 line, and it is the whole point.
        //
        // ^-ANCHORED (/m) for the same reason the modern summary matcher inside
        // parseTestOutput is: `dotnet test` prints a test's OWN stdout INDENTED
        // under "Standard Output Messages:", so an unanchored match would let
        // submitted source forge this line with one Console.WriteLine. Failing
        // closed costs a false negative (the caller learns no more than it does
        // today); failing open would assert "there is no suite" about a suite
        // that ran and died.
        const ZERO_COLLECTION_MARKER =
            /^(?:No test is available in |No test matches the given testcase filter|Zero tests ran)/m;

        // Mirrors the verdict's own inputs so the two cannot disagree: the
        // verdict is green only when `passed > 0`, this is raisable only when
        // `passed === 0`, so `no_tests_run === true` can never accompany
        // `success === true`. `failed === 0` is required too — a run with
        // failures plainly executed test bodies.
        const ranNoTestBodies = results.tests.passed === 0 && results.tests.failed === 0;
        const runnerFoundNothing =
            (results.tests.executionSuccess === true && results.tests.total === 0) ||
            ZERO_COLLECTION_MARKER.test(testResult.stdout || '') ||
            ZERO_COLLECTION_MARKER.test(testResult.stderr || '');

        // restore/build are re-read here rather than assumed from control flow:
        // the two early returns above ship the initialised `false`, and this
        // expression has to reach the same answer from the same evidence.
        //
        // ⚠️ Those first two conjuncts are DELIBERATELY REDUNDANT and no test
        // can kill them: this line is only reached when both early returns were
        // skipped, so both are already true. Measured — deleting them leaves the
        // suite 181/181 green. They are kept as a guard against a future edit
        // that makes either failure fall through instead of returning, and they
        // are NOT evidence that the suite covers this clause. Do not read the
        // green suite as proof they matter.
        results.no_tests_run =
            results.restore.success === true &&
            results.compilation.success === true &&
            ranNoTestBodies &&
            runnerFoundNothing;

        log.info(`C# test execution completed: ${executionId}`, {
            duration: results.duration,
            success: results.success,
            noTestsRun: results.no_tests_run,
            tests: results.tests?.total || 0,
            passed: results.tests?.passed || 0,
            failed: results.tests?.failed || 0
        });
        
        res.json(results);
        
        // Clean up project directory after a delay
        setTimeout(async () => {
            try {
                await fs.rmdir(projectPath, { recursive: true });
                log.debug(`Cleaned up project directory: ${projectPath}`);
            } catch (cleanupError) {
                log.warn(`Failed to clean up project directory: ${projectPath}`, { error: cleanupError.message });
            }
        }, 120000); // Clean up after 2 minutes
        
    } catch (error) {
        log.error(`C# test execution error: ${executionId}`, { error: error.message });
        res.status(500).json({
            executionId,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
        });
    }
});

/**
 * Get framework information
 */
app.get('/frameworks', (req, res) => {
    res.json({
        supported: SUPPORTED_FRAMEWORKS,
        commands: DOTNET_COMMANDS,
        capabilities: {
            testExecution: true,
            codeCoverage: true,
            staticAnalysis: true,
            packageScanning: true,
            multipleFrameworks: true,
            targetFrameworks: ['net6.0', 'net7.0', 'net8.0', 'netstandard2.0', 'netstandard2.1']
        }
    });
});

/**
 * Validate C# code syntax
 */
app.post('/validate', async (req, res) => {
    const validationId = crypto.randomUUID();
    
    try {
        const { code, projectType = 'console', targetFramework = 'net8.0' } = req.body || {};
        
        // Validate input
        if (code === undefined || code === null) {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['No code provided'],
                output: ''
            });
        }
        
        // `code` must be a string here. Unlike /execute — which accepts an object
        // of { filename: contents } and branches on typeof — validation writes a
        // single source file, so anything non-string is a caller contract error.
        // Without this guard the next line calls code.trim() on e.g. an object and
        // the TypeError surfaces as a 500 that names no field; report the field and
        // the type we actually received instead. (typeof [] === 'object', so arrays
        // are reported explicitly or the message would be actively misleading.)
        if (typeof code !== 'string') {
            const receivedType = Array.isArray(code) ? 'array' : typeof code;
            return res.status(400).json({
                validationId,
                valid: false,
                errors: [`Field 'code' must be a string, received ${receivedType}`],
                output: ''
            });
        }

        // Empty code is not valid C#
        if (code.trim() === '') {
            return res.json({
                validationId,
                valid: false,
                errors: ['Empty code is not valid C#'],
                output: ''
            });
        }
        
        // Create temporary project for validation
        const tempPath = path.join(TEST_WORKSPACE, validationId);
        await fs.mkdir(tempPath, { recursive: true });
        
        // Create project
        await executeCommand(['dotnet', 'new', projectType, '--framework', targetFramework], { cwd: tempPath });
        
        // Write the code
        const mainFile = projectType === 'console' ? 'Program.cs' : 'Class1.cs';
        await fs.writeFile(path.join(tempPath, mainFile), code);
        
        // Try to build the project
        const buildResult = await executeCommand(['dotnet', 'build'], { cwd: tempPath });
        
        // Clean up
        await fs.rmdir(tempPath, { recursive: true });
        
        // Parse output to separate errors from warnings
        const outputLines = ((buildResult.stdout || '') + '\n' + (buildResult.stderr || '')).split('\n').filter(line => line.trim());
        const errors = [];
        const warnings = [];
        
        outputLines.forEach(line => {
            if (line.includes('error CS') || line.includes('error MSB') || line.includes(': error')) {
                errors.push(line);
            } else if (line.includes('warning CS') || line.includes('warning MSB') || line.includes(': warning')) {
                warnings.push(line);
            }
        });
        
        res.json({
            validationId,
            valid: buildResult.success,
            errors: errors.length > 0 ? errors : (buildResult.success ? [] : ['Build failed']),
            output: buildResult.stdout || '',
            warnings: warnings.length > 0 ? warnings : undefined
        });
        
    } catch (error) {
        log.error(`C# validation error: ${validationId}`, { error: error.message });
        res.status(500).json({
            validationId,
            valid: false,
            error: error.message
        });
    }
});

/**
 * Run specific dotnet command
 */
app.post('/run-command', async (req, res) => {
    const commandId = crypto.randomUUID();
    
    try {
        const { command, projectPath, arguments: cmdArgs = [] } = req.body || {};

        // `command` is either a DOTNET_COMMANDS key or a raw 'dotnet ...' string,
        // and both checks below assume a string: DOTNET_COMMANDS[command] on a
        // non-string coerces to a garbage key and then .startsWith() throws, so a
        // missing or wrong-typed field surfaced as a 500 instead of a contract
        // error. Guard first, and name the field plus the type we received.
        // (typeof [] === 'object', so arrays are reported explicitly.)
        if (typeof command !== 'string') {
            const receivedType = Array.isArray(command) ? 'array' : typeof command;
            return res.status(400).json({
                error: `Field 'command' must be a string, received ${receivedType}`,
                supportedCommands: Object.keys(DOTNET_COMMANDS)
            });
        }
        
        // Only the fixed map is executable. The old contract also accepted a raw
        // "dotnet ..." string, which made the PROCESS NAME itself request-controlled
        // — command injection by construction, whatever spawn API is used.
        const baseCommand = DOTNET_COMMANDS[command];
        if (!baseCommand) {
            return res.status(400).json({
                error: `Unsupported command: ${command}`,
                supportedCommands: Object.keys(DOTNET_COMMANDS)
            });
        }

        // Each caller argument becomes ONE literal argv element (execFile never
        // invokes a shell), and anything not shaped like a CLI flag is rejected
        // outright rather than passed through.
        const SAFE_ARGUMENT = /^[A-Za-z0-9_.:/=+-]+$/;
        const argv = baseCommand.split(' ');
        for (const arg of cmdArgs) {
            const value = String(arg);
            if (!SAFE_ARGUMENT.test(value)) {
                return res.status(400).json({
                    error: `Unsupported argument: ${value}`,
                    supportedCommands: Object.keys(DOTNET_COMMANDS)
                });
            }
            argv.push(value);
        }
        const fullCommand = argv.join(' ');

        // projectPath becomes the child process's cwd, so it must resolve inside
        // the service workspace. An absolute path or ../ escape is refused rather
        // than running dotnet in a directory the caller chose.
        const workspace = path.resolve(TEST_WORKSPACE);
        const workingDir = projectPath
            ? path.resolve(workspace, String(projectPath))
            : workspace;
        if (workingDir !== workspace && !workingDir.startsWith(workspace + path.sep)) {
            return res.status(400).json({
                error: 'projectPath must be inside the service workspace',
                workspace,
                supportedCommands: Object.keys(DOTNET_COMMANDS)
            });
        }

        const result = await executeCommand(argv, { cwd: workingDir });
        
        res.json({
            commandId,
            command: fullCommand,
            success: result.success,
            output: result.stdout,
            errors: result.stderr,
            exitCode: result.exitCode
        });
        
    } catch (error) {
        log.error(`Command execution error: ${commandId}`, { error: error.message });
        res.status(500).json({
            commandId,
            success: false,
            error: error.message
        });
    }
});

// Start server only when run directly
/* istanbul ignore next -- server startup not executed in tests */
if (require.main === module) {
    app.listen(PORT, async () => {
        const nugetConfig = await ensureOfflineNuGetConfig();
        log.info(`C# Test Execution Service started on port ${PORT}`, {
            frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
            workspace: TEST_WORKSPACE,
            reportsDir: REPORTS_DIR,
            offlineNuGetConfig: nugetConfig.written ? nugetConfig.path : nugetConfig.reason
        });
    });

    // Graceful shutdown
    installGracefulShutdown({ log });
}

module.exports = {
    app,
    executeCommand,
    ensureOfflineNuGetConfig,
    isOfflineNuGet,
    analyzeVulnerablePackages,
    analyzeOutdatedPackages,
    parseTestOutput,
    parseCoverageResults,
    detectTestingFramework,
    OFFLINE_NUGET_CONFIG,
    SUPPORTED_FRAMEWORKS,
    DOTNET_COMMANDS
};
