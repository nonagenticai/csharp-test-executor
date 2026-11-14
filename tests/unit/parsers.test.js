const { parseTestOutput, parseCoverageResults, detectTestingFramework } = require('../../src/csharp_test_service');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// ─── parseTestOutput ────────────────────────────────────────────────────────

describe('parseTestOutput', () => {
    test('empty string returns zeroed results', () => {
        const result = parseTestOutput('');
        expect(result.total).toBe(0);
        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.testResults).toEqual([]);
        expect(result.duration).toBe(0);
    });

    test('parses summary line correctly', () => {
        const output = 'Total tests: 10. Passed: 8. Failed: 1. Skipped: 1';
        const result = parseTestOutput(output);
        expect(result.total).toBe(10);
        expect(result.passed).toBe(8);
        expect(result.failed).toBe(1);
        expect(result.skipped).toBe(1);
    });

    test('parses individual Passed test line', () => {
        const output = '  Passed  MyTestMethod [100ms]';
        const result = parseTestOutput(output);
        expect(result.testResults).toHaveLength(1);
        expect(result.testResults[0]).toEqual({
            status: 'passed',
            name: 'MyTestMethod',
            duration: '100ms',
            success: true
        });
    });

    test('parses individual Failed test line', () => {
        const output = '  Failed  BadTest [200ms]';
        const result = parseTestOutput(output);
        expect(result.testResults).toHaveLength(1);
        expect(result.testResults[0]).toEqual({
            status: 'failed',
            name: 'BadTest',
            duration: '200ms',
            success: false
        });
    });

    test('parses individual Skipped test line with duration', () => {
        const output = '  Skipped  SkippedTest [50ms]';
        const result = parseTestOutput(output);
        expect(result.testResults).toHaveLength(1);
        expect(result.testResults[0]).toEqual({
            status: 'skipped',
            name: 'SkippedTest',
            duration: '50ms',
            success: false
        });
    });

    test('skipped test without duration brackets is not captured by individual test regex', () => {
        // The regex requires [duration] brackets so bare "Skipped TestName" won't match
        const output = '  Skipped  SkippedTest';
        const result = parseTestOutput(output);
        expect(result.testResults).toHaveLength(0);
    });

    test('parses duration line', () => {
        const output = 'Total time: 00:00:05.123';
        const result = parseTestOutput(output);
        expect(result.duration).toBe('00:00:05.123');
    });

    test('parses multiple test results in full output', () => {
        const output = [
            'Starting test execution...',
            '  Passed  TestA [10ms]',
            '  Passed  TestB [20ms]',
            '  Failed  TestC [30ms]',
            '  Skipped  TestD [5ms]',
            'Total tests: 4. Passed: 2. Failed: 1. Skipped: 1',
            'Total time: 00:00:01.500'
        ].join('\n');

        const result = parseTestOutput(output);
        expect(result.total).toBe(4);
        expect(result.passed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.testResults).toHaveLength(4);
        expect(result.duration).toBe('00:00:01.500');

        expect(result.testResults[0].name).toBe('TestA');
        expect(result.testResults[0].success).toBe(true);
        expect(result.testResults[1].name).toBe('TestB');
        expect(result.testResults[2].name).toBe('TestC');
        expect(result.testResults[2].success).toBe(false);
        expect(result.testResults[3].name).toBe('TestD');
        expect(result.testResults[3].status).toBe('skipped');
    });

    test('no matching lines returns empty results', () => {
        const output = 'Some random log output\nAnother line\nBuild succeeded.';
        const result = parseTestOutput(output);
        expect(result.total).toBe(0);
        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.testResults).toEqual([]);
        expect(result.duration).toBe(0);
    });

    test('parses test name with dots (namespace-qualified)', () => {
        const output = '  Passed  MyNamespace.MyClass.TestMethod [42ms]';
        const result = parseTestOutput(output);
        expect(result.testResults).toHaveLength(1);
        expect(result.testResults[0].name).toBe('MyNamespace.MyClass.TestMethod');
    });

    test('parses summary with zero counts', () => {
        const output = 'Total tests: 5. Passed: 5. Failed: 0. Skipped: 0';
        const result = parseTestOutput(output);
        expect(result.total).toBe(5);
        expect(result.passed).toBe(5);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);
    });

    test('parses large numbers in summary', () => {
        const output = 'Total tests: 1234. Passed: 1200. Failed: 30. Skipped: 4';
        const result = parseTestOutput(output);
        expect(result.total).toBe(1234);
        expect(result.passed).toBe(1200);
        expect(result.failed).toBe(30);
        expect(result.skipped).toBe(4);
    });
});

// ─── parseCoverageResults ───────────────────────────────────────────────────

describe('parseCoverageResults', () => {
    test('null input returns null', () => {
        expect(parseCoverageResults(null)).toBeNull();
    });

    test('undefined input returns null', () => {
        expect(parseCoverageResults(undefined)).toBeNull();
    });

    test('empty string returns null (falsy)', () => {
        expect(parseCoverageResults('')).toBeNull();
    });

    test('parses XML with line-rate and branch-rate attributes', () => {
        const xml = '<coverage line-rate="0.85" branch-rate="0.72">';
        const result = parseCoverageResults(xml);
        expect(result).not.toBeNull();
        expect(result.lineRate).toBe('85.00');
        expect(result.branchRate).toBe('72.00');
    });

    test('parses XML with line-rate of 1.0 (100%)', () => {
        const xml = '<coverage line-rate="1.0" branch-rate="1.0">';
        const result = parseCoverageResults(xml);
        expect(result.lineRate).toBe('100.00');
        expect(result.branchRate).toBe('100.00');
    });

    test('parses XML with line-rate of 0 (0%)', () => {
        const xml = '<coverage line-rate="0" branch-rate="0">';
        const result = parseCoverageResults(xml);
        expect(result.lineRate).toBe('0.00');
        expect(result.branchRate).toBe('0.00');
    });

    test('parses XML with LINE counter (covered/missed)', () => {
        const xml = '<counter type="LINE" covered="80" missed="20"/>';
        const result = parseCoverageResults(xml);
        expect(result).not.toBeNull();
        expect(result.lines).toEqual({
            covered: 80,
            missed: 20,
            total: 100,
            percentage: '80.00'
        });
    });

    test('parses XML with BRANCH counter', () => {
        const xml = '<counter type="BRANCH" covered="30" missed="10"/>';
        const result = parseCoverageResults(xml);
        expect(result).not.toBeNull();
        expect(result.branches).toEqual({
            covered: 30,
            missed: 10,
            total: 40,
            percentage: '75.00'
        });
    });

    test('parses XML with both LINE and BRANCH counters', () => {
        const xml = [
            '<report>',
            '  <counter type="LINE" covered="100" missed="0"/>',
            '  <counter type="BRANCH" covered="50" missed="50"/>',
            '</report>'
        ].join('\n');
        const result = parseCoverageResults(xml);
        expect(result.lines.percentage).toBe('100.00');
        expect(result.branches.percentage).toBe('50.00');
    });

    test('LINE counter with zero covered and missed returns 0.00%', () => {
        const xml = '<counter type="LINE" covered="0" missed="0"/>';
        const result = parseCoverageResults(xml);
        expect(result.lines.percentage).toBe('0.00');
        expect(result.lines.total).toBe(0);
    });

    test('malformed XML without matching patterns returns empty object', () => {
        const xml = '<garbled>not real coverage data</garbled>';
        const result = parseCoverageResults(xml);
        // No matches found, but no error thrown, returns empty object
        expect(result).toEqual({});
    });

    test('non-string truthy input (number) triggers catch block and returns null', () => {
        // Passing a number: truthy so it passes the !xmlContent check,
        // but .match() on a number throws TypeError
        const result = parseCoverageResults(42);
        expect(result).toBeNull();
    });

    test('object input triggers catch block and returns null', () => {
        const result = parseCoverageResults({ not: 'a string' });
        expect(result).toBeNull();
    });

    test('full Cobertura XML with both rate and counter data', () => {
        const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<coverage line-rate="0.9" branch-rate="0.75" version="1.0">',
            '  <packages>',
            '    <package>',
            '      <counter type="LINE" covered="90" missed="10"/>',
            '      <counter type="BRANCH" covered="75" missed="25"/>',
            '    </package>',
            '  </packages>',
            '</coverage>'
        ].join('\n');
        const result = parseCoverageResults(xml);
        expect(result.lineRate).toBe('90.00');
        expect(result.branchRate).toBe('75.00');
        expect(result.lines.covered).toBe(90);
        expect(result.lines.missed).toBe(10);
        expect(result.branches.covered).toBe(75);
        expect(result.branches.missed).toBe(25);
    });
});

// ─── detectTestingFramework ─────────────────────────────────────────────────

describe('detectTestingFramework', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csharp-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('returns xunit when csproj contains xunit reference', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'Test.csproj'),
            '<PackageReference Include="xunit" Version="2.4.1" />'
        );
        const result = await detectTestingFramework(tmpDir);
        expect(result).toBe('xunit');
    });

    test('returns nunit when csproj contains NUnit reference', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'Test.csproj'),
            '<PackageReference Include="NUnit" Version="3.13.3" />'
        );
        const result = await detectTestingFramework(tmpDir);
        expect(result).toBe('nunit');
    });

    test('returns mstest when csproj contains MSTest reference', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'Test.csproj'),
            '<PackageReference Include="MSTest.TestFramework" Version="2.2.10" />'
        );
        const result = await detectTestingFramework(tmpDir);
        expect(result).toBe('mstest');
    });

    test('returns xunit by default when no recognized framework found', async () => {
        await fs.writeFile(
            path.join(tmpDir, 'Test.csproj'),
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup></PropertyGroup></Project>'
        );
        const result = await detectTestingFramework(tmpDir);
        expect(result).toBe('xunit');
    });

    test('returns xunit when no csproj files exist', async () => {
        // tmpDir has no files
        const result = await detectTestingFramework(tmpDir);
        expect(result).toBe('xunit');
    });

    test('returns xunit on read error (non-existent directory)', async () => {
        const result = await detectTestingFramework('/nonexistent/path/xyz');
        expect(result).toBe('xunit');
    });

    test('picks first csproj file if multiple exist', async () => {
        // Write two csproj files - readdir returns alphabetical order
        await fs.writeFile(
            path.join(tmpDir, 'A.csproj'),
            '<PackageReference Include="NUnit" />'
        );
        await fs.writeFile(
            path.join(tmpDir, 'B.csproj'),
            '<PackageReference Include="MSTest.TestFramework" />'
        );
        const result = await detectTestingFramework(tmpDir);
        // A.csproj comes first alphabetically, contains NUnit
        expect(result).toBe('nunit');
    });
});
