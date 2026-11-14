// Regression tests for the two package-analysis features that were broken in
// production. A real /execute against the live pod returned success overall but
// embedded:
//
//   security.vulnerablePackages -> "Attempted to divide by zero."   (SDK crash,
//       because ensureOfflineNuGetConfig clears every package source and NuGet's
//       list-package runner divides by the source count)
//   security.outdatedPackages   -> "dotnet-outdated does not exist" (global tool
//       never installed, and unusable offline even if it were)
//
// Both must now degrade honestly: an explicit skip with a stated reason, and no
// raw toolchain error as the whole story.

const request = require('supertest');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return { ...original, exec: jest.fn() };
});

jest.mock('fs', () => {
    const actualFs = jest.requireActual('fs');
    return {
        ...actualFs,
        promises: {
            ...actualFs.promises,
            mkdir: jest.fn().mockResolvedValue(undefined),
            writeFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn().mockResolvedValue(''),
            readdir: jest.fn().mockResolvedValue([]),
            rmdir: jest.fn().mockResolvedValue(undefined),
            rm: jest.fn().mockResolvedValue(undefined),
        }
    };
});

const { exec } = require('child_process');
const { app } = require('../../src/csharp_test_service');

const DIVIDE_BY_ZERO = [
    'Unhandled exception. System.DivideByZeroException: Attempted to divide by zero.',
    '   at NuGet.CommandLine.XPlat.ListPackageCommandRunner.ExecuteCommandAsync()'
].join('\n');

// Command-addressed exec mock: matches on the command string rather than call
// order, so a step that is legitimately SKIPPED does not shift every later
// result the way an index-based sequence would.
function mockExecByCommand(overrides = {}) {
    exec.mockImplementation((cmd, opts, cb) => {
        const key = Object.keys(overrides).find((k) => cmd.includes(k));
        const result = key
            ? overrides[key]
            : {
                stdout: cmd.includes('dotnet test')
                    ? 'Total tests: 1. Passed: 1. Failed: 0. Skipped: 0\nTotal time: 00:00:01.000'
                    : 'OK',
                stderr: '',
                error: null
            };

        const child = { killed: false, kill: jest.fn(() => { child.killed = true; }) };
        process.nextTick(() => cb(result.error || null, result.stdout || '', result.stderr || ''));
        return child;
    });
}

function execCommands() {
    return exec.mock.calls.map((c) => c[0]);
}

function runExecute() {
    return request(app)
        .post('/execute')
        .send({
            code: 'public class Calc { public int Add(int a, int b) => a + b; }',
            testCode: 'using Xunit; public class Tests { [Fact] public void T() { Assert.Equal(2, 1+1); } }'
        });
}

const ORIGINAL_FALLBACK = process.env.NUGET_FALLBACK_PACKAGES;

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NUGET_FALLBACK_PACKAGES;
});

afterAll(() => {
    if (ORIGINAL_FALLBACK === undefined) delete process.env.NUGET_FALLBACK_PACKAGES;
    else process.env.NUGET_FALLBACK_PACKAGES = ORIGINAL_FALLBACK;
});

describe('vulnerable-package analysis does not leak the SDK divide-by-zero crash', () => {
    test('a DivideByZeroException is reported as an explicit skip with a reason', async () => {
        mockExecByCommand({
            'dotnet list package --vulnerable': { stdout: '', stderr: DIVIDE_BY_ZERO, error: { code: 134 } }
        });

        const res = await runExecute();
        const vuln = res.body.security.vulnerablePackages;

        expect(res.status).toBe(200);
        expect(vuln.success).toBe(false);
        expect(vuln.skipped).toBe(true);
        expect(typeof vuln.reason).toBe('string');
        expect(vuln.reason.length).toBeGreaterThan(20);
        expect(vuln.reason).toMatch(/package source|NuGet feed/i);
        // The reason must EXPLAIN, not just echo the crash back at the caller.
        expect(vuln.reason).not.toMatch(/^Attempted to divide by zero/);
    });

    test('offline runtime never invokes the crashing command at all', async () => {
        process.env.NUGET_FALLBACK_PACKAGES = '/opt/nuget-fallback';
        mockExecByCommand({
            'dotnet list package --vulnerable': { stdout: '', stderr: DIVIDE_BY_ZERO, error: { code: 134 } }
        });

        const res = await runExecute();
        const vuln = res.body.security.vulnerablePackages;

        expect(execCommands().some((c) => c.includes('--vulnerable'))).toBe(false);
        expect(vuln.skipped).toBe(true);
        expect(vuln.success).toBe(false);
        expect(vuln.reason).toMatch(/no internet egress|cannot run here/i);
        expect(JSON.stringify(vuln)).not.toMatch(/divide by zero/i);
        expect(res.body.security.offline).toBe(true);
    });

    test('a working vulnerability scan is still reported verbatim', async () => {
        mockExecByCommand({
            'dotnet list package --vulnerable': {
                stdout: 'The given project has no vulnerable packages given the current sources.',
                stderr: '',
                error: null
            }
        });

        const vuln = (await runExecute()).body.security.vulnerablePackages;

        expect(vuln.success).toBe(true);
        expect(vuln.skipped).toBeUndefined();
        expect(vuln.output).toMatch(/no vulnerable packages/);
    });
});

describe('outdated-package analysis degrades instead of emitting a raw tool error', () => {
    test('a missing dotnet-outdated tool is reported as an explicit skip with a reason', async () => {
        mockExecByCommand({
            'dotnet outdated': {
                stdout: '',
                stderr: 'Could not execute because the specified command or file was not found.\n'
                    + 'dotnet-outdated does not exist',
                error: { code: 1 }
            }
        });

        const outdated = (await runExecute()).body.security.outdatedPackages;

        expect(outdated.success).toBe(false);
        expect(outdated.skipped).toBe(true);
        expect(typeof outdated.reason).toBe('string');
        expect(outdated.reason).toMatch(/not installed/i);
        expect(outdated.reason).toMatch(/unavailable|cannot reach/i);
        expect(outdated.reason).not.toMatch(/^dotnet-outdated does not exist/);
    });

    test('offline runtime never invokes dotnet outdated at all', async () => {
        process.env.NUGET_FALLBACK_PACKAGES = '/opt/nuget-fallback';
        mockExecByCommand({
            'dotnet outdated': { stdout: '', stderr: 'dotnet-outdated does not exist', error: { code: 1 } }
        });

        const res = await runExecute();
        const outdated = res.body.security.outdatedPackages;

        expect(execCommands().some((c) => c.includes('dotnet outdated'))).toBe(false);
        expect(outdated.skipped).toBe(true);
        expect(outdated.success).toBe(false);
        expect(outdated.reason).toMatch(/cannot run here/i);
        expect(JSON.stringify(outdated)).not.toMatch(/does not exist/i);
    });
});

describe('security block still honours the rest of the contract', () => {
    test('a degraded security block does not fail the overall execution', async () => {
        process.env.NUGET_FALLBACK_PACKAGES = '/opt/nuget-fallback';
        mockExecByCommand({});

        const res = await runExecute();

        expect(res.body.success).toBe(true);
        expect(res.body.security.vulnerablePackages.skipped).toBe(true);
        expect(res.body.security.outdatedPackages.skipped).toBe(true);
    });
});
