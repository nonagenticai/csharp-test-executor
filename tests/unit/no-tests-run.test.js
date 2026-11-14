// `no_tests_run` on the REAL execution path.
//
// The question these tests exist to keep answerable is NOT "did it pass?" —
// `success` already answers that — but "which KIND of not-a-pass is this?".
// There are three, and a caller responds differently to each:
//
//   (a) the runner ran and discovered NOTHING   -> no_tests_run true
//   (b) the suite ran and tests FAILED          -> no_tests_run false
//   (c) setup failed, or the test host CRASHED  -> no_tests_run false
//
// A two-outcome test suite (pass / not-pass) cannot tell (a) from (b) from
// (c), which is exactly the defect: `success:false` collapses all three.

const request = require('supertest');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn()
    };
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

function mockExecSequence(results) {
    let callIndex = 0;
    exec.mockImplementation((cmd, opts, cb) => {
        const result = callIndex < results.length
            ? results[callIndex]
            : { stdout: '', stderr: '', error: null };
        callIndex++;

        const child = { killed: false, kill: jest.fn(() => { child.killed = true; }) };
        process.nextTick(() => {
            if (result.error) {
                cb(result.error, result.stdout || '', result.stderr || '');
            } else {
                cb(null, result.stdout || '', result.stderr || '');
            }
        });
        return child;
    });
}

const OK = { stdout: 'OK', stderr: '', error: null };

// 6 scaffold/wiring commands, then restore, then build, then `dotnet test`,
// then format + the two package scans. Only the test step varies per case.
function sequenceWithTestStep(testStep) {
    return [OK, OK, OK, OK, OK, OK, OK, OK, testStep, OK, OK, OK];
}

function post() {
    return request(app)
        .post('/execute')
        .send({ code: 'public class C {}', testCode: 'public class T {}' });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('no_tests_run distinguishes zero-collection from failure', () => {
    // (a) ZERO COLLECTION. This is the case the real path could not report at
    // all. Note the exit code: `dotnet test` exits 1 when it discovers nothing,
    // so a derivation gated on exit 0 would silently never fire here.
    test('zero discovery -> no_tests_run true, success false, exit non-zero', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: [
                'Determining projects to restore...',
                'Starting test execution, please wait...',
                'A total of 1 test files matched the specified pattern.',
                'No test is available in /workspace/X.Tests/bin/Debug/net8.0/X.Tests.dll. '
                    + 'Make sure that test discoverer & executables are registered and platform '
                    + '& framework version settings are appropriate and try again.'
            ].join('\n'),
            stderr: '',
            error: { code: 1 }
        }));

        const res = await post();

        expect(res.status).toBe(200);
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
        // The evidence the flag is derived from, pinned explicitly: the runner
        // ran (restore+build green) and exited NON-ZERO having found nothing.
        expect(res.body.restore.success).toBe(true);
        expect(res.body.compilation.success).toBe(true);
        expect(res.body.tests.executionSuccess).toBe(false);
        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
    });

    test('a filter that matches nothing is also zero discovery', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'No test matches the given testcase filter `FullyQualifiedName~Nope` in X.Tests.dll',
            stderr: '',
            error: { code: 1 }
        }));

        const res = await post();
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
    });

    test('a clean run whose summary counts zero tests is zero discovery', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Passed!  - Failed:     0, Passed:     0, Skipped:     0, Total:     0',
            stderr: '',
            error: null
        }));

        const res = await post();
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
        expect(res.body.tests.executionSuccess).toBe(true);
    });

    // (b) A GREEN SUITE. Tests were collected and passed: nothing about this run
    // is a "not run".
    test('all tests passed -> no_tests_run false, success true', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3',
            stderr: '',
            error: null
        }));

        const res = await post();

        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(true);
        expect(res.body.tests.passed).toBe(3);
    });

    // (c) A RED SUITE. Also `success:false`, but for the opposite reason — and
    // this is the pair the caller could not previously tell apart.
    test('some tests failed -> no_tests_run false, success false', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3',
            stderr: '',
            error: { code: 1 }
        }));

        const res = await post();

        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
        expect(res.body.tests.failed).toBe(1);
    });

    // The harder half of (c): EVERY test failed, so passed === 0 just as in the
    // zero-collection case. Only `failed > 0` separates them.
    test('every test failed -> no_tests_run false even though passed === 0', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Failed!  - Failed:     2, Passed:     0, Skipped:     0, Total:     2',
            stderr: '',
            error: { code: 1 }
        }));

        const res = await post();

        expect(res.body.tests.passed).toBe(0);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });

    // (d) SETUP FAILURES. Both return early, before `dotnet test` is ever
    // invoked. Nothing was discovered because nothing got as far as discovery —
    // asserting `false` here (and not `undefined`) is what makes the field
    // readable on every response shape this path can produce.
    test('restore failure -> no_tests_run false and present', async () => {
        mockExecSequence([
            OK, OK, OK, OK, OK, OK,
            { stdout: '', stderr: 'NU1301: Unable to load the service index', error: { code: 1 } },
        ]);

        const res = await post();

        expect(res.body.restore.success).toBe(false);
        expect(res.body.compilation).toBeNull();
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
        expect(exec.mock.calls.some((c) => c[0].startsWith('dotnet test'))).toBe(false);
    });

    test('build failure -> no_tests_run false and present', async () => {
        mockExecSequence([
            OK, OK, OK, OK, OK, OK,
            OK, // restore
            { stdout: '', stderr: 'error CS1002: ; expected', error: { code: 1 } }, // build
        ]);

        const res = await post();

        expect(res.body.compilation.success).toBe(false);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
        expect(exec.mock.calls.some((c) => c[0].startsWith('dotnet test'))).toBe(false);
    });

    // A CRASHED test host is the case a naive `passed === 0 && failed === 0`
    // derivation gets wrong: it looks identical to zero discovery in the counts,
    // and differs only in that the runner never said it found nothing.
    test('test host crash -> no_tests_run false, not mislabelled as zero discovery', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Starting test execution, please wait...',
            stderr: 'The active test run was aborted. Reason: Test host process crashed',
            error: { code: 134 }
        }));

        const res = await post();

        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });

    // An all-skipped run DID collect tests. It executes no test bodies, so it is
    // correctly not a pass, but it is not "there is no suite" either.
    test('all tests skipped -> collected, so no_tests_run false', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: 'Skipped!  - Failed:     0, Passed:     0, Skipped:     2, Total:     2',
            stderr: '',
            error: null
        }));

        const res = await post();

        expect(res.body.tests.total).toBe(2);
        expect(res.body.tests.skipped).toBe(2);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });

    // Submitted source can print anything, and `dotnet test` echoes a test's own
    // stdout INDENTED under "Standard Output Messages:" — which is why the
    // marker is ^-anchored.
    //
    // THIS is the case that makes the anchor load-bearing: a test body that
    // printed the diagnostic and then took the host down leaves passed === 0 and
    // failed === 0, so every other guard in the derivation is satisfied and the
    // anchor is the ONLY thing standing between "this run crashed" and the
    // service asserting "you have no tests". Removing `^` from the matcher
    // turns this green run red — verified by mutation, after an earlier version
    // of this test (a forged line on a PASSING run) turned out to prove nothing:
    // `passed > 0` already decided it, so the anchor was never consulted.
    test('an indented forgery cannot relabel a crashed run as zero discovery', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: [
                '  Standard Output Messages:',
                '    No test is available in /workspace/X.Tests.dll. Make sure that test discoverer',
                ''
            ].join('\n'),
            stderr: 'The active test run was aborted. Reason: Test host process crashed',
            error: { code: 134 }
        }));

        const res = await post();

        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });

    test('an indented forgery does not flip the flag on a genuinely green run', async () => {
        mockExecSequence(sequenceWithTestStep({
            stdout: [
                '  Standard Output Messages:',
                '    No test is available in /workspace/X.Tests.dll. Make sure that test discoverer',
                'Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1'
            ].join('\n'),
            stderr: '',
            error: null
        }));

        const res = await post();

        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(true);
    });

    // Structural invariant, independent of any single scenario: a run that
    // executed nothing verified nothing, so the two fields can never both be
    // affirmative. `success` requires passed > 0 and `no_tests_run` requires
    // passed === 0, so this holds by construction — pinned so a future edit to
    // either expression cannot quietly break it.
    test('no_tests_run true and success true are mutually exclusive', async () => {
        const cases = [
            { stdout: 'No test is available in /workspace/X.Tests.dll.', stderr: '', error: { code: 1 } },
            { stdout: 'Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1', stderr: '', error: null },
            { stdout: 'Failed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1', stderr: '', error: { code: 1 } },
        ];

        for (const testStep of cases) {
            jest.clearAllMocks();
            mockExecSequence(sequenceWithTestStep(testStep));
            const res = await post();
            expect(res.body.no_tests_run && res.body.success).toBe(false);
        }
    });
});

describe('both spellings agree on the probe fast path', () => {
    test('probe emits noTestsRun and no_tests_run, both true', async () => {
        const res = await request(app).post('/execute').send({ code: '// test' });

        expect(res.body.noTestsRun).toBe(true);
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
        expect(exec).not.toHaveBeenCalled();
    });
});
