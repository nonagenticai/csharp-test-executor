const { parseTestOutput, parseCoverageResults } = require('../../src/csharp_test_service');

// Regression tests for the js/polynomial-redos alerts on these parsers
// (src/csharp_test_service.js: the per-test line matcher and the three
// coverage-XML matchers). Each input below is the exact adversarial shape the
// CodeQL alert named. Measured against the OLD regexes on 2026-11-15: the 10 KB
// per-test line took ~150 s, so a reintroduced matcher fails the jest timeout,
// while the linear parsers finish in single-digit milliseconds. The explicit
// budget is deliberately loose so a loaded CI box cannot flake.
const LINEAR_TIME_BUDGET_MS = 2000;

function measure(fn) {
    const started = process.hrtime.bigint();
    const value = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { value, elapsedMs };
}

describe('parser linear-time guarantees (js/polynomial-redos regression)', () => {
    test('per-test line of repeated whitespace with no closing bracket', () => {
        const line = `  Passed ${'  '.repeat(5000)}`; // ~10 KB
        const { value, elapsedMs } = measure(() => parseTestOutput(line));
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value.testResults).toEqual([]);
        expect(value.total).toBe(0);
    });

    test('per-test line ending in one very long whitespace run with no bracket', () => {
        // The alert's other named shape: 'Passed a' followed by many repetitions
        // of ' ' — the old `\s+(.+?)\s+\[` re-scanned the run from every split
        // point.
        const line = `  Passed a${' '.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => parseTestOutput(line));
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value.testResults).toEqual([]);
    });

    test('coverage XML repeating <coverage with no attributes', () => {
        const xml = '<coverage'.repeat(6000); // ~54 KB
        const { value, elapsedMs } = measure(() => parseCoverageResults(xml));
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toEqual({});
    });

    test('coverage XML repeating <counter type="LINE"> with no attributes', () => {
        const xml = '<counter type="LINE"'.repeat(2800); // ~54 KB
        const { value, elapsedMs } = measure(() => parseCoverageResults(xml));
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toEqual({});
    });

    test('coverage XML repeating <counter type="BRANCH"> with no attributes', () => {
        const xml = '<counter type="BRANCH"'.repeat(2700); // ~54 KB
        const { value, elapsedMs } = measure(() => parseCoverageResults(xml));
        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toEqual({});
    });

    test('coverage XML whose first candidate tag lacks a digit counter does not swallow a later valid one', () => {
        const xml = [
            '<counter type="LINE" covered="not-a-number" missed="0">',
            '<counter type="LINE" covered="80" missed="20">'
        ].join('');
        const result = parseCoverageResults(xml);
        expect(result.lines).toEqual({ covered: 80, missed: 20, total: 100, percentage: '80.00' });
    });

    test('a tag without rates does not hide a later <coverage> tag that has them', () => {
        const xml = '<coverage><coverage line-rate="0.5" branch-rate="0.25">';
        const result = parseCoverageResults(xml);
        expect(result.lineRate).toBe('50.00');
        expect(result.branchRate).toBe('25.00');
    });
});

describe('parseTestResultLine semantics preserved by the linear scan', () => {
    test('a name starting with a bracket is kept when a later bracket starts the duration', () => {
        const result = parseTestOutput('  Passed  [Theory] My test name [1 ms]');
        expect(result.testResults).toEqual([
            { status: 'passed', name: '[Theory] My test name', duration: '1 ms', success: true }
        ]);
    });

    test('a bracket not preceded by whitespace is not a duration boundary', () => {
        const result = parseTestOutput('  Passed  Test[a]');
        expect(result.testResults).toEqual([]);
    });

    test('empty duration is not a result line', () => {
        const result = parseTestOutput('  Passed  Test []');
        expect(result.testResults).toEqual([]);
    });
});
