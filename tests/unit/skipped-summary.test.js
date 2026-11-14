const { parseTestOutput } = require('../../src/csharp_test_service');

// EXACT shape the shipped SDK prints when every test is [Fact(Skip="wip")]
// (observed live on the csharp-test-executor pod, 2026-08-18). dotnet uses a
// THIRD banner word for this case — `Skipped!` — which the modern matcher did
// not accept, so the run was reported as tests:{total:0,skipped:0}: the counts
// handed to callers were simply wrong.
const LIVE_ALL_SKIPPED_OUTPUT = [
    'Test run for /app/test_workspace/9f21c0be/CSharpTest_9f21c0be.Tests/bin/Debug/net8.0/CSharpTest_9f21c0be.Tests.dll (.NETCoreApp,Version=v8.0)',
    'VSTest version 17.11.1 (x64)',
    '',
    'Starting test execution, please wait...',
    'A total of 1 test files matched the specified pattern.',
    '  Skipped UnitTest1.T [1 ms]',
    '',
    'Skipped! - Failed:     0, Passed:     0, Skipped:     1, Total:     1, Duration: 1 ms - CSharpTest_9f21c0be.Tests.dll (net8.0)',
    '',
].join('\n');

describe('parseTestOutput: all-skipped run (Skipped! banner)', () => {
    test('counts the real live all-skipped output', () => {
        const r = parseTestOutput(LIVE_ALL_SKIPPED_OUTPUT);
        expect(r.total).toBe(1);
        expect(r.skipped).toBe(1);
        expect(r.passed).toBe(0);
        expect(r.failed).toBe(0);
    });

    test('the Skipped! line sets the modern dialect flag, so a stale legacy line cannot win', () => {
        // Both dialects present: modern must be adopted, never the legacy tally
        // and never the sum. Without modern.seen being set on a Skipped! line,
        // this silently falls back to the legacy numbers.
        const r = parseTestOutput([
            'Total tests: 99. Passed: 99. Failed: 0. Skipped: 0.',
            'Skipped! - Failed: 0, Passed: 0, Skipped: 2, Total: 2 - A.dll (net8.0)',
        ].join('\n'));
        expect(r.total).toBe(2);
        expect(r.skipped).toBe(2);
        expect(r.passed).toBe(0);
    });

    test('mixed multi-assembly: a Skipped! dll and a Passed! dll ACCUMULATE', () => {
        const r = parseTestOutput([
            'Skipped! - Failed:     0, Passed:     0, Skipped:     2, Total:     2, Duration: 2 ms - A.Tests.dll (net8.0)',
            'Passed!  - Failed:     0, Passed:     3, Skipped:     1, Total:     4, Duration: 5 ms - B.Tests.dll (net8.0)',
        ].join('\n'));
        expect(r.total).toBe(6);
        expect(r.passed).toBe(3);
        expect(r.failed).toBe(0);
        expect(r.skipped).toBe(3);
    });

    test('an INDENTED forged Skipped! summary is still untrusted', () => {
        // The anchor must stay strict `^`. A submitted test controls its own
        // stdout, which dotnet echoes indented.
        const r = parseTestOutput([
            '  Standard Output Messages:',
            '    Skipped! - Failed: 0, Passed: 50, Skipped: 0, Total: 50 - Evil.dll',
            'Skipped! - Failed: 0, Passed: 0, Skipped: 1, Total: 1 - Real.dll (net8.0)',
        ].join('\n'));
        expect(r.total).toBe(1);
        expect(r.passed).toBe(0);
        expect(r.skipped).toBe(1);
    });
});

describe('the all-skipped VERDICT is unchanged by the counting fix', () => {
    // The success rule (src/csharp_test_service.js: results.success = ... &&
    // results.tests.passed > 0 && ...) is what stops an all-skipped run reading
    // as green. Fixing the COUNTS must not make it green: skipped:1 now reports
    // honestly, but passed is still 0.
    const successRule = (tests, compilationSuccess = true) =>
        compilationSuccess &&
        tests.executionSuccess === true &&
        tests.passed > 0 &&
        tests.failed === 0;

    test('all-skipped is still success:false even though total/skipped are now correct', () => {
        const tests = { ...parseTestOutput(LIVE_ALL_SKIPPED_OUTPUT), executionSuccess: true };
        expect(tests.total).toBe(1);      // the fix
        expect(tests.skipped).toBe(1);    // the fix
        expect(tests.failed).toBe(0);     // exit code 0, nothing failed
        expect(successRule(tests)).toBe(false); // the verdict, unchanged
    });

    test('a genuinely passing run is still success:true', () => {
        const tests = {
            ...parseTestOutput('Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1 - X.dll (net8.0)'),
            executionSuccess: true,
        };
        expect(successRule(tests)).toBe(true);
    });
});
