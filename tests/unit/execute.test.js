const request = require('supertest');

// Mock child_process before requiring the app
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn()
    };
});

// Mock fs.promises for file operations
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

// Helper to set up exec mock to simulate command results
function mockExecSequence(results) {
    let callIndex = 0;
    exec.mockImplementation((cmd, opts, cb) => {
        const result = callIndex < results.length
            ? results[callIndex]
            : { stdout: '', stderr: '', error: null };
        callIndex++;

        const child = {
            killed: false,
            kill: jest.fn(() => { child.killed = true; })
        };

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

// Helper to create a default successful exec sequence for a full /execute flow
// Steps: new sln, new classlib, new xunit, sln add core, sln add test,
//        add reference, restore, build, test, format, vulnerable, outdated
function mockAllSuccessful(testOutput) {
    const successResult = { stdout: 'OK', stderr: '', error: null };
    const testResult = {
        stdout: testOutput || 'Total tests: 2. Passed: 2. Failed: 0. Skipped: 0\nTotal time: 00:00:01.000',
        stderr: '',
        error: null
    };
    // 6 setup commands + restore + build + test + format + vulnerable + outdated = 12
    return [
        successResult, // dotnet new sln
        successResult, // dotnet new classlib
        successResult, // dotnet new xunit
        successResult, // dotnet sln add Core
        successResult, // dotnet sln add Tests
        successResult, // dotnet add reference
        successResult, // dotnet restore
        successResult, // dotnet build
        testResult,    // dotnet test
        successResult, // dotnet format
        successResult, // dotnet list package --vulnerable
        successResult, // dotnet outdated
    ];
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('POST /execute', () => {
    test('probe path for "// test" answers without invoking dotnet', async () => {
        // No exec calls should be made for the probe path
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(res.body.executionId).toBeDefined();
        expect(res.body.skipped).toBe(true);
        expect(res.body.noTestsRun).toBe(true);
        expect(res.body.reason).toBe('probe_payload');
        // Nothing was restored or compiled, so neither may be reported as a success.
        expect(res.body.restore).toBeNull();
        expect(res.body.compilation).toBeNull();
        expect(res.body.success).toBe(false);
        expect(exec).not.toHaveBeenCalled();
    });

    // CHANGED (was: 'probe path reports zero tests even when testCode is
    // supplied'). That assertion enshrined a silent-drop bug: a caller sending a
    // placeholder `code` plus a real suite in `testCode` got 200/noTestsRun and
    // no error, and their suite never ran. A probe carries nothing to run, so a
    // request WITH testCode must take the real path.
    test('a request with testCode is NOT a probe, even when code is "// test"', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({ code: '// test', testCode: 'some test code' });

        expect(res.status).toBe(200);
        expect(exec).toHaveBeenCalled();
        expect(exec.mock.calls.some((c) => c[0].startsWith('dotnet test'))).toBe(true);
        expect(res.body.skipped).toBeUndefined();
        expect(res.body.noTestsRun).toBeUndefined();
        expect(res.body.reason).toBeUndefined();
    });

    test('probe path without testCode reports zero tests', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.passed).toBe(0);
    });

    test('missing code and testCode returns 400', async () => {
        mockExecSequence([]);
        const res = await request(app)
            .post('/execute')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('At least one of code or testCode is required');
    });

    test('missing request body returns 400', async () => {
        const res = await request(app)
            .post('/execute')
            .send(null);

        // Express parses null body as empty object, so code/testCode are both undefined
        expect(res.status).toBe(400);
    });

    test('valid code with all build steps succeeding returns structured response', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calculator { public int Add(int a, int b) => a + b; }',
                testCode: 'using Xunit; public class Tests { [Fact] public void Test1() { Assert.Equal(2, 1+1); } }',
                framework: 'xunit',
                targetFramework: 'net8.0'
            });

        expect(res.status).toBe(200);
        expect(res.body.executionId).toBeDefined();
        expect(res.body.framework).toBe('xunit');
        expect(res.body.targetFramework).toBe('net8.0');
        expect(res.body.restore).toBeDefined();
        expect(res.body.restore.success).toBe(true);
        expect(res.body.compilation).toBeDefined();
        expect(res.body.compilation.success).toBe(true);
        expect(res.body.tests).toBeDefined();
        expect(res.body.tests.total).toBe(2);
        expect(res.body.tests.passed).toBe(2);
        expect(res.body.tests.failed).toBe(0);
        expect(res.body.success).toBe(true);
        expect(res.body.duration).toBeGreaterThanOrEqual(0);
    });

    test('restore failure returns early with restore error', async () => {
        const results = [
            { stdout: 'OK', stderr: '', error: null }, // dotnet new sln
            { stdout: 'OK', stderr: '', error: null }, // dotnet new classlib
            { stdout: 'OK', stderr: '', error: null }, // dotnet new xunit
            { stdout: 'OK', stderr: '', error: null }, // dotnet sln add Core
            { stdout: 'OK', stderr: '', error: null }, // dotnet sln add Tests
            { stdout: 'OK', stderr: '', error: null }, // dotnet add reference
            { stdout: '', stderr: 'Package not found', error: { code: 1 } }, // dotnet restore FAILS
        ];
        mockExecSequence(results);

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                testCode: 'public class FooTests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.restore.success).toBe(false);
        expect(res.body.compilation).toBeNull();
        expect(res.body.tests).toBeNull();
    });

    test('build failure returns early with compilation error', async () => {
        const results = [
            { stdout: 'OK', stderr: '', error: null }, // dotnet new sln
            { stdout: 'OK', stderr: '', error: null }, // dotnet new classlib
            { stdout: 'OK', stderr: '', error: null }, // dotnet new xunit
            { stdout: 'OK', stderr: '', error: null }, // dotnet sln add Core
            { stdout: 'OK', stderr: '', error: null }, // dotnet sln add Tests
            { stdout: 'OK', stderr: '', error: null }, // dotnet add reference
            { stdout: 'Restored', stderr: '', error: null }, // dotnet restore OK
            { stdout: '', stderr: 'error CS1001: Identifier expected', error: { code: 1 } }, // build FAILS
        ];
        mockExecSequence(results);

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'invalid c# code {{{{',
                testCode: 'public class Tests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.restore.success).toBe(true);
        expect(res.body.compilation.success).toBe(false);
        expect(res.body.compilation.exitCode).toBe(1);
        expect(res.body.tests).toBeNull();
    });

    test('test failure produces test results with failures', async () => {
        const testOutput = [
            '  Passed  Test1 [10ms]',
            '  Failed  Test2 [20ms]',
            'Total tests: 2. Passed: 1. Failed: 1. Skipped: 0',
            'Total time: 00:00:00.500'
        ].join('\n');

        const results = mockAllSuccessful(testOutput);
        // The test command (index 8) should return with error code since tests fail
        results[8] = { stdout: testOutput, stderr: '', error: { code: 1 } };
        mockExecSequence(results);

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class CalcTests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.tests.total).toBe(2);
        expect(res.body.tests.passed).toBe(1);
        expect(res.body.tests.failed).toBe(1);
        expect(res.body.success).toBe(false); // failed > 0 => not success
    });

    test('code provided as object with multiple files writes each', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: {
                    'Calculator.cs': 'public class Calculator {}',
                    'Helper.cs': 'public class Helper {}'
                },
                testCode: 'public class Tests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.executionId).toBeDefined();
    });

    test('dependencies trigger dotnet add package commands', async () => {
        // 6 setup + 1 dep + restore + build + test + format + vulnerable + outdated = 13
        const allResults = [];
        for (let i = 0; i < 13; i++) {
            allResults.push({ stdout: 'OK', stderr: '', error: null });
        }
        // test command at index 9 (after 6 setup + 1 dep + restore + build)
        allResults[9] = {
            stdout: 'Total tests: 1. Passed: 1. Failed: 0. Skipped: 0\nTotal time: 00:00:00.100',
            stderr: '',
            error: null
        };
        mockExecSequence(allResults);

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                testCode: 'public class Tests {}',
                dependencies: { 'Newtonsoft.Json': '13.0.3' }
            });

        expect(res.status).toBe(200);
        // Verify dotnet add package was called
        const addPackageCall = exec.mock.calls.find(call => call[0].includes('dotnet add') && call[0].includes('package'));
        expect(addPackageCall).toBeDefined();
        expect(addPackageCall[0]).toContain('Newtonsoft.Json');
        expect(addPackageCall[0]).toContain('13.0.3');
    });

    test('nunit framework uses nunit template', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                testCode: 'public class Tests {}',
                framework: 'nunit'
            });

        expect(res.status).toBe(200);
        // The third exec call should use nunit template
        const templateCall = exec.mock.calls[2];
        expect(templateCall[0]).toContain('dotnet new nunit');
    });

    test('mstest framework uses mstest template', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                testCode: 'public class Tests {}',
                framework: 'mstest'
            });

        expect(res.status).toBe(200);
        const templateCall = exec.mock.calls[2];
        expect(templateCall[0]).toContain('dotnet new mstest');
    });

    test('coverage reading when TestResults directory has coverage file', async () => {
        const fs = require('fs');
        // Override readdir mock for coverage directory - it will be called for the TestResults dir
        fs.promises.readdir.mockImplementation(async () => {
            return ['guid-dir-1'];
        });
        // Override readFile mock to return coverage XML for the coverage file
        fs.promises.readFile.mockImplementation(async () => {
            return '<coverage line-rate="0.85" branch-rate="0.70">';
        });

        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc { public int Add(int a, int b) => a + b; }',
                testCode: 'public class Tests { }'
            });

        expect(res.status).toBe(200);
        expect(res.body.coverage).toBeDefined();
        expect(res.body.coverage.success).toBe(true);
        expect(res.body.coverage.metrics).toBeDefined();
        expect(res.body.coverage.metrics.lineRate).toBe('85.00');
        expect(res.body.coverage.metrics.branchRate).toBe('70.00');

        // Reset mocks
        fs.promises.readdir.mockResolvedValue([]);
        fs.promises.readFile.mockResolvedValue('');
    });

    test('coverage graceful degradation when no coverage files found', async () => {
        const fs = require('fs');
        // readdir returns dirs but readFile fails
        fs.promises.readdir.mockResolvedValueOnce(['dir1']);
        fs.promises.readFile.mockRejectedValueOnce(new Error('ENOENT'));

        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.coverage).toBeDefined();
        expect(res.body.coverage.success).toBe(false);
        expect(res.body.coverage.error).toBe('Coverage files not found');
    });

    test('coverage directory not found triggers warning', async () => {
        const fs = require('fs');
        // readdir rejects for coverage TestResults directory
        fs.promises.readdir.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}'
            });

        expect(res.status).toBe(200);
        expect(res.body.coverage).toBeDefined();
        expect(res.body.coverage.success).toBe(false);
    });

    test('options.generateCoverage=false skips coverage step', async () => {
        // Without coverage: 6 setup + restore + build + test + format + vulnerable + outdated = 12
        // But test command won't include --collect
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}',
                options: { generateCoverage: false }
            });

        expect(res.status).toBe(200);
        expect(res.body.coverage).toBeNull();
        // Verify test command doesn't include coverage flag
        const testCall = exec.mock.calls.find(call => call[0].includes('dotnet test'));
        expect(testCall[0]).not.toContain('--collect');
    });

    test('options.checkFormatting=false skips formatting step', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}',
                options: { checkFormatting: false }
            });

        expect(res.status).toBe(200);
        expect(res.body.formatting).toBeNull();
    });

    test('options.runSecurityScan=false skips security step', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}',
                options: { runSecurityScan: false }
            });

        expect(res.status).toBe(200);
        expect(res.body.security).toBeNull();
    });

    test('only testCode provided (no code) still executes', async () => {
        mockExecSequence(mockAllSuccessful());

        const res = await request(app)
            .post('/execute')
            .send({
                testCode: 'public class Tests { [Fact] public void Test1() {} }'
            });

        expect(res.status).toBe(200);
        expect(res.body.executionId).toBeDefined();
    });

    test('fs.mkdir failure triggers 500 error response', async () => {
        const fs = require('fs');
        fs.promises.mkdir.mockRejectedValueOnce(new Error('Permission denied'));

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                testCode: 'public class Tests {}'
            });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('Permission denied');
        expect(res.body.executionId).toBeDefined();
    });

});
