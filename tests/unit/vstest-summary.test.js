const { parseTestOutput } = require('../../src/csharp_test_service');

// The EXACT bytes the shipped SDK produced on the first /execute that ever got
// as far as running tests (live, csharp-test-executor pod, 2026-08-16). The run
// PASSED and the parser returned total=0, which — because results.success
// requires tests.total > 0 — reported a green test run as a failed execution.
const LIVE_PASSING_OUTPUT = [
    'Test run for /app/test_workspace/a45c4ada/CSharpTest_a45c4ada.Tests/bin/Debug/net8.0/CSharpTest_a45c4ada.Tests.dll (.NETCoreApp,Version=v8.0)',
    'VSTest version 17.11.1 (x64)',
    '',
    'Starting test execution, please wait...',
    'A total of 1 test files matched the specified pattern.',
    '',
    'Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: < 1 ms - CSharpTest_a45c4ada.Tests.dll (net8.0)',
    '',
].join('\n');

describe('parseTestOutput: modern VSTest summary', () => {
    test('counts a passing run from the real live output', () => {
        const r = parseTestOutput(LIVE_PASSING_OUTPUT);
        expect(r.total).toBe(1);
        expect(r.passed).toBe(1);
        expect(r.failed).toBe(0);
        expect(r.skipped).toBe(0);
    });

    test('counts a failing run', () => {
        const r = parseTestOutput(
            'Failed!  - Failed:     2, Passed:     3, Skipped:     1, Total:     6, Duration: 12 ms - X.Tests.dll (net8.0)'
        );
        expect(r).toMatchObject({ total: 6, passed: 3, failed: 2, skipped: 1 });
    });

    test('ACCUMULATES across assemblies — VSTest prints one summary line per test dll', () => {
        const r = parseTestOutput(
            [
                'Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 3 ms - A.Tests.dll (net8.0)',
                'Failed!  - Failed:     1, Passed:     4, Skipped:     0, Total:     5, Duration: 9 ms - B.Tests.dll (net8.0)',
            ].join('\n')
        );
        // Assigning instead of accumulating would report only B: 5/4/1.
        expect(r).toMatchObject({ total: 7, passed: 6, failed: 1, skipped: 0 });
    });

    test('the legacy summary still parses — older SDKs print it', () => {
        const r = parseTestOutput('Total tests: 5. Passed: 4. Failed: 1. Skipped: 0.');
        expect(r).toMatchObject({ total: 5, passed: 4, failed: 1, skipped: 0 });
    });

    test('prose that merely mentions Passed does not inflate the count', () => {
        const r = parseTestOutput(
            [
                'Starting test execution, please wait...',
                '  Passed CalcTests.Adds [1 ms]',
                'A total of 1 test files matched the specified pattern.',
            ].join('\n')
        );
        // Per-test lines populate testResults, never the summary counters.
        expect(r.total).toBe(0);
        expect(r.testResults).toHaveLength(1);
        expect(r.testResults[0]).toMatchObject({ status: 'passed', success: true });
    });
});

describe('parseTestOutput: dialect handling', () => {
    // D5: the two summary dialects describe the SAME run. Legacy used to ASSIGN
    // while modern ACCUMULATED, so output carrying both counted each test twice.
    test('output carrying BOTH dialects does not double-count', () => {
        const r = parseTestOutput(
            [
                'Total tests: 3. Passed: 3. Failed: 0. Skipped: 0.',
                'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 4 ms - X.Tests.dll (net8.0)',
            ].join('\n')
        );
        expect(r).toMatchObject({ total: 3, passed: 3, failed: 0, skipped: 0 });
    });

    test('legacy accumulates across assemblies, exactly like modern', () => {
        const r = parseTestOutput(
            [
                'Total tests: 2. Passed: 2. Failed: 0. Skipped: 0.',
                'Total tests: 5. Passed: 4. Failed: 1. Skipped: 0.',
            ].join('\n')
        );
        // Assigning would report only the last assembly: 5/4/1.
        expect(r).toMatchObject({ total: 7, passed: 6, failed: 1, skipped: 0 });
    });

    // REVERSED DELIBERATELY. This case previously asserted that an INDENTED
    // summary still counts, to avoid a false negative if some SDK verbosity
    // indents the real summary. Allowing that turned out to be exploitable:
    // `dotnet test` echoes a test's OWN stdout indented under "Standard Output
    // Messages:", so submitted code could print a summary-shaped line and
    // inflate the tally — an all-skipped run reporting success:true, verified
    // end-to-end through /execute. See forged-summary-cannot-inflate.test.js.
    //
    // A real summary starts at column 0; indented text is untrusted echo. The
    // cost is a false NEGATIVE (total=0 -> success:false) if a future SDK
    // indents the genuine line. For a service whose entire defect history is
    // reporting passes it never ran, failing closed beats failing open — and
    // the indentation tolerance was speculative while the forgery is
    // demonstrated.
    test('an INDENTED summary is NOT counted — it is untrusted echo', () => {
        const r = parseTestOutput(
            '    Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4, Duration: 5 ms - X.Tests.dll (net8.0)'
        );
        expect(r).toMatchObject({ total: 0, passed: 0 });
    });

    test('an all-skipped run reports zero passed', () => {
        const r = parseTestOutput(
            'Passed!  - Failed:     0, Passed:     0, Skipped:     3, Total:     3, Duration: 2 ms - X.Tests.dll (net8.0)'
        );
        expect(r).toMatchObject({ total: 3, passed: 0, failed: 0, skipped: 3 });
    });
});
