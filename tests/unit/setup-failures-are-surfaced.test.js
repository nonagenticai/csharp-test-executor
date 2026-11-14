const request = require('supertest');

// Mock child_process before requiring the app
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn()
    };
});

// Mock fs.promises: the handler mkdirs under /app/test_workspace, which does not
// exist on a CI runner. Same shape as execute.test.js.
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
        const child = { killed: false, kill: jest.fn() };
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

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// D4: `dotnet sln add`, `dotnet add ... reference` and `dotnet add ... package`
// used to be awaited and DISCARDED. executeCommand RESOLVES on failure instead
// of throwing, so nothing noticed. A declared dependency that never installed,
// or a project reference that never got wired, still let `dotnet build` succeed
// and the caller was handed success:true.
// ---------------------------------------------------------------------------
const OK = { stdout: 'OK', stderr: '', error: null };

function failure(stderr) {
    const err = new Error('Command failed');
    err.code = 1;
    return { error: err, stdout: '', stderr };
}

describe('project wiring and dependency failures are surfaced', () => {
    test('a failing `dotnet sln add` returns 500 with its stderr', async () => {
        // 0-2 scaffold, 3 = sln add core project
        mockExecSequence([OK, OK, OK, failure('MSB1009: Project file does not exist.')]);

        const res = await request(app)
            .post('/execute')
            .send({ code: 'public class Foo {}', testCode: 'public class Tests {}' });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('Failed to add core project to solution');
        expect(res.body.errors).toContain('MSB1009');
    });

    test('a failing `dotnet add ... reference` returns 500 instead of a green build', async () => {
        // 0-2 scaffold, 3-4 sln add, 5 = project reference
        mockExecSequence([OK, OK, OK, OK, OK, failure('Reference could not be added.')]);

        const res = await request(app)
            .post('/execute')
            .send({ code: 'public class Foo {}', testCode: 'public class Tests {}' });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to add project reference');
        expect(res.body.errors).toContain('Reference could not be added.');
        // The run must stop here: nothing may be built or tested on a project
        // whose test assembly cannot see the code under test.
        expect(exec.mock.calls.some((c) => c[0].startsWith('dotnet test'))).toBe(false);
    });

    test('a failing `dotnet add package` is reported, never a success with a missing dep', async () => {
        // 0-5 setup, 6 = dotnet add package
        mockExecSequence([
            OK, OK, OK, OK, OK, OK,
            failure('error NU1101: Unable to find package Newtonsoft.Jsonn. No packages exist with this id.'),
        ]);

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                testCode: 'public class Tests {}',
                dependencies: { 'Newtonsoft.Jsonn': '13.0.3' }
            });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('Failed to add dependency Newtonsoft.Jsonn@13.0.3');
        expect(res.body.errors).toContain('NU1101');
        // Previously the build ran anyway and, because nothing referenced the
        // package yet, succeeded -> success:true with the dependency absent.
        expect(exec.mock.calls.some((c) => c[0].startsWith('dotnet build'))).toBe(false);
    });
});
