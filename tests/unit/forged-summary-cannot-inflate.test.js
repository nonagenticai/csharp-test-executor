const { parseTestOutput } = require('../../src/csharp_test_service');

// A submitted test controls its own stdout, and `dotnet test` echoes it INDENTED
// under "Standard Output Messages:". If the summary matcher tolerates leading
// whitespace, that echo is parsed as a real per-assembly summary and inflates
// the tally — turning an all-skipped run into success:true. Untrusted input must
// never reach the tally.
describe('a forged summary line in captured stdout cannot inflate the tally', () => {
    const forged = [
        'A total of 1 test files matched the specified pattern.',
        '  Skipped T.A [1 ms]',
        '  Standard Output Messages:',
        '    Passed!  - Failed: 0, Passed: 9, Skipped: 0, Total: 9',
        '    Passed!  - Failed: 0, Passed: 9, Skipped: 0, Total: 9 - Evil.dll',
        '',
        'Passed!  - Failed: 0, Passed: 0, Skipped: 1, Total: 1 - Real.dll (net8.0)'
    ].join('\n');

    test('only the column-0 summary is counted', () => {
        const r = parseTestOutput(forged);
        expect(r.total).toBe(1);
        expect(r.passed).toBe(0);
        expect(r.skipped).toBe(1);
    });

    test('a .dll suffix does not buy the forged line any trust', () => {
        // The second forged line carries `- Evil.dll` precisely because that
        // suffix was considered as a discriminator and rejected as forgeable.
        expect(parseTestOutput(forged).passed).toBe(0);
    });

    test('real multi-assembly summaries still ACCUMULATE', () => {
        const multi = [
            'Passed!  - Failed: 0, Passed: 3, Skipped: 0, Total: 3 - A.dll (net8.0)',
            'Passed!  - Failed: 1, Passed: 4, Skipped: 1, Total: 6 - B.dll (net8.0)'
        ].join('\n');
        const r = parseTestOutput(multi);
        expect(r.total).toBe(9);
        expect(r.passed).toBe(7);
        expect(r.failed).toBe(1);
    });
});
