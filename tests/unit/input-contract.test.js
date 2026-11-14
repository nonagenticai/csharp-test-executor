const request = require('supertest');

// Mock child_process before requiring the app. The assertions below lean on the
// exec mock staying UNCALLED: a rejected request must never reach the compiler.
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
    };
});

// Mock fs.promises so the one happy-path /validate case does not touch disk.
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
const { app, DOTNET_COMMANDS } = require('../../src/csharp_test_service');

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

beforeEach(() => {
    jest.clearAllMocks();
});

describe('POST /validate input contract', () => {
    // Each of these used to reach code.trim() and 500 with
    // "code.trim is not a function" — a message that names no field.
    test('object code returns 400 naming the field and the received type', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: { 'Class1.cs': 'public class C {}' } });

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors[0]).toContain("'code'");
        expect(res.body.errors[0]).toContain('object');
        expect(res.body.output).toBe('');
        expect(res.body.validationId).toBeDefined();
        expect(execFile).not.toHaveBeenCalled();
    });

    test('array code is reported as "array", not "object"', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: ['public class C {}'] });

        expect(res.status).toBe(400);
        expect(res.body.errors[0]).toContain('array');
        expect(res.body.errors[0]).not.toContain('object');
        expect(execFile).not.toHaveBeenCalled();
    });

    test('numeric code returns 400 reporting number', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: 42 });

        expect(res.status).toBe(400);
        expect(res.body.errors[0]).toContain('number');
        expect(execFile).not.toHaveBeenCalled();
    });

    // The null/undefined branch predates the type guard and other tests depend on
    // its exact wording; the guard must sit AFTER it, not swallow it.
    test('undefined code still returns the original "No code provided" 400', async () => {
        const res = await request(app)
            .post('/validate')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('No code provided');
    });

    test('null code still returns the original "No code provided" 400', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: null });

        expect(res.status).toBe(400);
        expect(res.body.errors).toContain('No code provided');
    });

    test('valid string code still reaches the compiler', async () => {
        mockExecSequence([
            { stdout: 'Project created.', stderr: '', error: null },
            { stdout: 'Build succeeded.', stderr: '', error: null }
        ]);

        const res = await request(app)
            .post('/validate')
            .send({ code: 'Console.WriteLine("Hello");' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(execFile).toHaveBeenCalledTimes(2);
        expect([execFile.mock.calls[0][0], ...execFile.mock.calls[0][1]].join(' ')).toContain('dotnet new');
        expect([execFile.mock.calls[1][0], ...execFile.mock.calls[1][1]].join(' ')).toContain('dotnet build');
    });
});

describe('POST /run-command input contract', () => {
    test.each([
        ['object', { build: true }],
        ['array', ['build']],
        ['number', 7],
        ['boolean', true]
    ])('non-string command (%s) returns 400 and runs no shell command', async (label, value) => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: value });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'command'");
        expect(res.body.error).toContain(label);
        expect(res.body.supportedCommands).toEqual(Object.keys(DOTNET_COMMANDS));
        // The load-bearing assertion: nothing was handed to exec.
        expect(execFile).not.toHaveBeenCalled();
    });

    test('null command returns 400 and runs no shell command', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: null });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'command'");
        expect(execFile).not.toHaveBeenCalled();
    });

    test('unsupported string command still returns the original 400 shape', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: 'rm -rf /' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported command');
        expect(execFile).not.toHaveBeenCalled();
    });

    test('a raw dotnet command string is refused, not executed', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: 'dotnet --version' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported command');
        expect(execFile).not.toHaveBeenCalled();
    });
});

describe('POST /execute probe path', () => {
    test('the "// test" probe is answered without exec', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(res.body.skipped).toBe(true);
        expect(res.body.compilation).toBeNull();
        expect(execFile).not.toHaveBeenCalled();
    });

    // CHANGED: this used to send `testCode: '// t'` and assert the probe
    // swallowed it, which pinned the silent-drop bug (a real suite in testCode
    // was never run, answered 200 with no error). The probe case now carries no
    // testCode; the testCode case asserts the real path is taken.
    test('the probe never reports a passing test', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(res.body.noTestsRun).toBe(true);
        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.passed).toBe(0);
        expect(res.body.tests.failed).toBe(0);
        expect(res.body.success).toBe(false);
    });

    test('"// test" plus a testCode is a real suite, not a probe', async () => {
        mockExecSequence([{ stdout: '', stderr: '', error: null }]);

        const res = await request(app)
            .post('/execute')
            .send({ code: '// test', testCode: '// t' });

        expect(res.body.noTestsRun).toBeUndefined();
        expect(execFile).toHaveBeenCalled();
    });

    test('object code is NOT rejected by /execute — it is a valid source map there', async () => {
        // /execute deliberately accepts { filename: contents }; the /validate type
        // guard must not have leaked into this endpoint. A non-string code skips the
        // probe path, so this request proceeds past input validation into scaffolding.
        mockExecSequence([{ stdout: '', stderr: '', error: null }]);

        const res = await request(app)
            .post('/execute')
            .send({
                code: { 'Class1.cs': 'public class C {}' },
                testCode: 'public class Tests {}'
            });

        expect(res.status).not.toBe(400);
        expect(execFile).toHaveBeenCalled();
    });
});
