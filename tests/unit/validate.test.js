const request = require('supertest');

// Mock child_process before requiring the app
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
    };
});

// Mock fs.promises
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

beforeEach(() => {
    jest.clearAllMocks();
});

describe('POST /validate', () => {
    test('no code (undefined) returns 400 with error message', async () => {
        const res = await request(app)
            .post('/validate')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('No code provided');
        expect(res.body.validationId).toBeDefined();
    });

    test('null code returns 400', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: null });

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('No code provided');
    });

    test('empty string code returns valid:false with empty code error', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: '' });

        // Empty code returns 200 with valid: false (not 400)
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('Empty code is not valid C#');
    });

    test('whitespace-only code returns valid:false', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: '   \n\t  ' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('Empty code is not valid C#');
    });

    test('valid C# code with successful build returns valid:true', async () => {
        // Validate does: dotnet new console, then dotnet build => 2 exec calls
        mockExecSequence([
            { stdout: 'Project created.', stderr: '', error: null },
            { stdout: 'Build succeeded.\n0 Warning(s)\n0 Error(s)', stderr: '', error: null }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'Console.WriteLine("Hello");' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.errors).toEqual([]);
        expect(res.body.validationId).toBeDefined();
    });

    test('invalid C# code with failed build returns valid:false with errors', async () => {
        mockExecSequence([
            { stdout: 'Project created.', stderr: '', error: null },
            {
                stdout: 'Program.cs(1,1): error CS1001: Identifier expected',
                stderr: '',
                error: { code: 1 }
            }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: '{{{{ not valid c#' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors.length).toBeGreaterThan(0);
        expect(res.body.errors[0]).toContain('error CS');
    });

    test('build with warnings but success returns valid:true with warnings', async () => {
        mockExecSequence([
            { stdout: 'Project created.', stderr: '', error: null },
            {
                stdout: 'Build succeeded.\nProgram.cs(2,5): warning CS0168: Variable declared but never used',
                stderr: '',
                error: null
            }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'int x; Console.WriteLine("Hello");' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.length).toBeGreaterThan(0);
        expect(res.body.warnings[0]).toContain('warning CS');
    });

    test('build failure without specific error codes returns generic "Build failed"', async () => {
        mockExecSequence([
            { stdout: 'Project created.', stderr: '', error: null },
            {
                stdout: 'Build FAILED.',
                stderr: 'Some generic error',
                error: { code: 1 }
            }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'broken code' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        // No CS/MSB error patterns, so fallback to 'Build failed'
        expect(res.body.errors).toContain('Build failed');
    });

    test('custom projectType is passed to dotnet new', async () => {
        mockExecSequence([
            { stdout: 'OK', stderr: '', error: null },
            { stdout: 'Build succeeded.', stderr: '', error: null }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'public class Lib {}', projectType: 'classlib' });

        expect(res.status).toBe(200);
        // Verify the first exec call used classlib template
        const newProjectCall = execFile.mock.calls[0];
        expect([newProjectCall[0], ...newProjectCall[1]].join(' ')).toContain('dotnet new classlib');
    });

    test('custom targetFramework is passed to dotnet new', async () => {
        mockExecSequence([
            { stdout: 'OK', stderr: '', error: null },
            { stdout: 'Build succeeded.', stderr: '', error: null }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'public class Lib {}', targetFramework: 'net6.0' });

        expect(res.status).toBe(200);
        const newProjectCall = execFile.mock.calls[0];
        expect([newProjectCall[0], ...newProjectCall[1]].join(' ')).toContain('net6.0');
    });

    test('validate response includes output field', async () => {
        mockExecSequence([
            { stdout: 'OK', stderr: '', error: null },
            { stdout: 'Build succeeded.\n0 warnings', stderr: '', error: null }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'Console.WriteLine("Hi");' });

        expect(res.status).toBe(200);
        expect(res.body.output).toBeDefined();
        expect(typeof res.body.output).toBe('string');
    });

    test('fs.mkdir failure triggers 500 error response', async () => {
        const fs = require('fs');
        fs.promises.mkdir.mockRejectedValueOnce(new Error('Disk full'));

        const res = await request(app)
            .post('/validate')
            .send({ code: 'public class Foo {}' });

        expect(res.status).toBe(500);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toBe('Disk full');
        expect(res.body.validationId).toBeDefined();
    });
});
