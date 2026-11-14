const request = require('supertest');

// Mock child_process before requiring the app
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
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

const { execFile } = require('child_process');
const { app } = require('../../src/csharp_test_service');

function mockExecSequence(results) {
    let callIndex = 0;
    execFile.mockImplementation((file, args, opts, cb) => {
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
// The scaffolder used to ignore `dotnet new`'s exit code. When it failed, the
// project directory did not exist and the NEXT statement — fs.writeFile of the
// source — threw
//   ENOENT ... /CSharpTest_<id>.Core/Class1.cs
// which reads as an application bug in the writer. The real cause was upstream
// and its stderr was discarded. Measured live on 2026-08-16: the true error was
// "Read-only file system : '/root/.templateengine'".
// ---------------------------------------------------------------------------
describe('scaffolding failures are surfaced, not swallowed', () => {
    test('a failing `dotnet new sln` returns 500 with the real stderr, not ENOENT', async () => {
        const err = new Error('Command failed');
        err.code = 1;
        mockExecSequence([
            { error: err, stdout: '', stderr: "Unhandled exception: System.IO.IOException: Read-only file system : '/root/.templateengine'" }
        ]);

        const res = await request(app)
            .post('/execute')
            .set('X-Tenant-Id', 'test')
            .send({ code: 'public class Calc { public int Add(int a,int b)=>a+b; }', testCode: 'public class T {}' });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to scaffold solution');
        expect(res.body.command).toContain('dotnet new sln');
        expect(res.body.errors).toContain('/root/.templateengine');
        // The defect signature must NOT appear: the old code got this far and
        // then blew up in the writer.
        expect(JSON.stringify(res.body)).not.toContain('ENOENT');
    });

    test('a failing test-project template names THAT step, not the solution', async () => {
        const ok = { stdout: '', stderr: '', error: null };
        const err = new Error('Command failed');
        err.code = 1;
        mockExecSequence([
            ok, // sln
            ok, // core project
            { error: err, stdout: '', stderr: 'NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json' }
        ]);

        const res = await request(app)
            .post('/execute')
            .set('X-Tenant-Id', 'test')
            .send({ code: 'public class Calc {}', testCode: 'public class T {}' });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to scaffold test project');
        expect(res.body.errors).toContain('NU1301');
    });
});

