// Regression: /execute must never report a passing test it did not run.
//
// The original fast path answered ANY string under 200 chars containing
// "class Test" (with no dependencies) with `passed: 1`, without invoking dotnet
// even once. These tests pin the two halves of the fix:
//   1. real source code goes down the real path and is actually executed;
//   2. the surviving `// test` probe reports zero tests run, honestly.

const request = require('supertest');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
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

const { execFile } = require('child_process');
const { app } = require('../../src/csharp_test_service');

function mockExecSequence(results) {
    let callIndex = 0;
    execFile.mockImplementation((file, args, opts, cb) => {
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

// 6 scaffold commands + restore + build + test + format + vulnerable + outdated
function mockAllSuccessful(testOutput) {
    const ok = { stdout: 'OK', stderr: '', error: null };
    return [
        ok, ok, ok, ok, ok, ok, ok, ok,
        { stdout: testOutput, stderr: '', error: null },
        ok, ok, ok
    ];
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('/execute never reports a pass it did not run', () => {
    // Under 200 chars, contains "class Test", no dependencies: this is exactly
    // what the old fast path swallowed.
    const SHORT_CODE_WITH_CLASS_TEST = 'public class Test { public int Add(int a, int b) => a + b; }';
    const REAL_TEST_CODE =
        'using Xunit; public class T { [Fact] public void A() { Assert.Equal(2, 1 + 1); } }';

    test('short code containing "class Test" is actually compiled and executed, not fast-pathed', async () => {
        mockExecSequence(mockAllSuccessful(
            'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 ms'
        ));

        const res = await request(app)
            .post('/execute')
            .send({ code: SHORT_CODE_WITH_CLASS_TEST, testCode: REAL_TEST_CODE });

        expect(res.status).toBe(200);
        // The load-bearing assertion: dotnet was invoked. The old code returned
        // `passed: 1` with exec never called.
        expect(execFile).toHaveBeenCalled();
        const commands = execFile.mock.calls.map((c) => [c[0], ...c[1]].join(' '));
        expect(commands.some((c) => c.startsWith('dotnet test'))).toBe(true);

        expect(res.body.output).not.toBe('Fast-path response for minimal test');
        // Numbers come from the real dotnet output, not from a hardcoded 1.
        expect(res.body.tests.total).toBe(3);
        expect(res.body.tests.passed).toBe(3);
    });

    test('short code containing "class Test" reports failure when the tests actually fail', async () => {
        mockExecSequence(mockAllSuccessful(
            'Failed!  - Failed:     2, Passed:     0, Skipped:     0, Total:     2, Duration: 1 ms'
        ));

        const res = await request(app)
            .post('/execute')
            .send({ code: SHORT_CODE_WITH_CLASS_TEST, testCode: REAL_TEST_CODE });

        expect(res.status).toBe(200);
        expect(res.body.tests.failed).toBe(2);
        expect(res.body.tests.passed).toBe(0);
        // The old fast path reported success:true / passed:1 for this same payload.
        expect(res.body.success).toBe(false);
    });

    // CHANGED: this case used to send `testCode: 'anything at all'` and ASSERT
    // that the probe swallowed it. That enshrined a second silent-drop bug — a
    // caller with a placeholder `code` and a genuine suite in `testCode` got
    // 200/noTestsRun and no error, and their suite never ran. A probe is a
    // request with nothing to run, so the probe case now sends no testCode, and
    // the testCode-carrying case below asserts the suite is really executed.
    test('the "// test" probe reports zero tests run, never a pass', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(execFile).not.toHaveBeenCalled();

        expect(res.body.noTestsRun).toBe(true);
        expect(res.body.skipped).toBe(true);
        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
        // Nothing ran, so nothing succeeded — same rule the full path applies.
        expect(res.body.success).toBe(false);
        // And it must not fabricate a green compilation it never performed.
        expect(res.body.compilation).toBeNull();
        expect(res.body.restore).toBeNull();
    });

    // D2: the probe sentinel must not swallow a real suite.
    test('"// test" WITH a real testCode is executed, not treated as a probe', async () => {
        mockExecSequence(mockAllSuccessful(
            'Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 1 ms'
        ));

        const res = await request(app)
            .post('/execute')
            .send({ code: '// test', testCode: REAL_TEST_CODE });

        expect(res.status).toBe(200);
        // The suite must actually run. Previously exec was never called and the
        // caller's tests were silently dropped with a 200 and no error.
        expect(execFile).toHaveBeenCalled();
        const commands = execFile.mock.calls.map((c) => [c[0], ...c[1]].join(' '));
        expect(commands.some((c) => c.startsWith('dotnet test'))).toBe(true);
        expect(res.body.skipped).toBeUndefined();
        expect(res.body.noTestsRun).toBeUndefined();
        expect(res.body.tests.total).toBe(2);
        expect(res.body.tests.passed).toBe(2);
        expect(res.body.success).toBe(true);
    });

    // D3: the probe response must be shaped like a real run, so a consumer
    // reaching into it does not get a TypeError instead of a lie.
    test('the probe emits the full response shape with honest empty values', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        // Keys the real path ALWAYS emits (results = {...}, plus results.tests).
        for (const key of [
            'executionId', 'framework', 'targetFramework', 'startTime',
            'restore', 'compilation', 'tests', 'coverage', 'formatting',
            'security', 'duration', 'success'
        ]) {
            expect(Object.prototype.hasOwnProperty.call(res.body, key)).toBe(true);
        }
        expect(res.body.coverage).toBeNull();
        expect(res.body.formatting).toBeNull();
        expect(res.body.security).toBeNull();
        expect(res.body.framework).toBe('xunit');
        expect(res.body.targetFramework).toBe('net8.0');
        expect(typeof res.body.startTime).toBe('string');

        // The real path builds tests as {...parseTestOutput(out), output, errors,
        // executionSuccess}; a consumer doing body.tests.output.includes(...)
        // must not throw.
        expect(typeof res.body.tests.output).toBe('string');
        expect(typeof res.body.tests.errors).toBe('string');
        expect(res.body.tests.output.includes('anything')).toBe(false);
        expect(res.body.tests.testResults).toEqual([]);
        expect(res.body.tests.executionSuccess).toBe(false);
    });

    // D1: skipped-only runs are not a pass.
    test('a run where every test is [Fact(Skip=...)] is NOT a success', async () => {
        // Real `dotnet test` output for three [Fact(Skip="wip")] facts: exit 0,
        // total 3, failed 0 — which the old rule (total > 0 && failed === 0)
        // called success:true with zero test bodies executed.
        const ALL_SKIPPED = [
            'Test run for /app/test_workspace/1c2d/CSharpTest_1c2d.Tests/bin/Debug/net8.0/CSharpTest_1c2d.Tests.dll (.NETCoreApp,Version=v8.0)',
            'VSTest version 17.11.1 (x64)',
            '',
            'Starting test execution, please wait...',
            'A total of 1 test files matched the specified pattern.',
            '  Skipped CalcTests.Adds [1 ms]',
            '  Skipped CalcTests.Subtracts [< 1 ms]',
            '  Skipped CalcTests.Divides [< 1 ms]',
            '',
            'Passed!  - Failed:     0, Passed:     0, Skipped:     3, Total:     3, Duration: 2 ms - CSharpTest_1c2d.Tests.dll (net8.0)',
            '',
        ].join('\n');

        mockExecSequence(mockAllSuccessful(ALL_SKIPPED));

        const res = await request(app)
            .post('/execute')
            .send({ code: SHORT_CODE_WITH_CLASS_TEST, testCode: REAL_TEST_CODE });

        expect(res.status).toBe(200);
        expect(res.body.tests.total).toBe(3);
        expect(res.body.tests.skipped).toBe(3);
        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
        // Nothing actually ran. Reporting this as green is the same lie the fast
        // path told.
        expect(res.body.success).toBe(false);
    });

    // D1 boundary: a partially-skipped suite with at least one real pass IS green.
    test('a run with one real pass and one skip is still a success', async () => {
        mockExecSequence(mockAllSuccessful(
            'Passed!  - Failed:     0, Passed:     1, Skipped:     1, Total:     2, Duration: 2 ms - X.Tests.dll (net8.0)'
        ));

        const res = await request(app)
            .post('/execute')
            .send({ code: SHORT_CODE_WITH_CLASS_TEST, testCode: REAL_TEST_CODE });

        expect(res.body.tests.passed).toBe(1);
        expect(res.body.success).toBe(true);
    });
});
