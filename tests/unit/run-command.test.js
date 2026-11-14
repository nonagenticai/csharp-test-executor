const request = require('supertest');

// Mock child_process
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
    };
});

const { execFile } = require('child_process');
const { app } = require('../../src/csharp_test_service');

function mockExec(result) {
    execFile.mockImplementation((file, args, opts, cb) => {
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

describe('POST /run-command', () => {
    test('known command key (build) executes mapped dotnet command', async () => {
        mockExec({ stdout: 'Build succeeded.', stderr: '', error: null });

        const res = await request(app)
            .post('/run-command')
            .send({ command: 'build' });

        expect(res.status).toBe(200);
        expect(res.body.commandId).toBeDefined();
        expect(res.body.command).toBe('dotnet build');
        expect(res.body.success).toBe(true);
        expect(res.body.output).toBe('Build succeeded.');
        expect(res.body.exitCode).toBe(0);
    });

    test('known command with arguments appends them', async () => {
        mockExec({ stdout: 'OK', stderr: '', error: null });

        const res = await request(app)
            .post('/run-command')
            .send({ command: 'test', arguments: ['--no-build', '--verbosity', 'detailed'] });

        expect(res.status).toBe(200);
        expect(res.body.command).toBe('dotnet test --no-build --verbosity detailed');
    });

    test('raw dotnet command strings are refused: only the fixed map executes', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: 'dotnet --version' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported command');
        expect(execFile).not.toHaveBeenCalled();
    });

    test('unsupported command returns 400', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: 'rm -rf /' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported command');
        expect(res.body.supportedCommands).toEqual(Object.keys(require('../../src/csharp_test_service').DOTNET_COMMANDS));
    });

    test('a workspace-relative projectPath is forwarded to executeCommand', async () => {
        mockExec({ stdout: 'OK', stderr: '', error: null });

        const res = await request(app)
            .post('/run-command')
            .send({ command: 'build', projectPath: 'job-42' });

        expect(res.status).toBe(200);
        // Relative to TEST_WORKSPACE (/app/test_workspace), never an arbitrary dir
        const execCall = execFile.mock.calls[0];
        expect(execCall[2].cwd).toBe('/app/test_workspace/job-42');
    });

    test('a projectPath that escapes the workspace is refused', async () => {
        for (const projectPath of ['/custom/project', '../../etc']) {
            const res = await request(app)
                .post('/run-command')
                .send({ command: 'build', projectPath });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain('inside the service workspace');
        }
        expect(execFile).not.toHaveBeenCalled();
    });

    test('an argument that is not shaped like a CLI flag is refused', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({ command: 'build', arguments: ['--no-restore; rm -rf /'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Unsupported argument');
        expect(execFile).not.toHaveBeenCalled();
    });

    test('command failure returns success:false with stderr', async () => {
        mockExec({ stdout: '', stderr: 'Build FAILED.', error: { code: 1 } });

        const res = await request(app)
            .post('/run-command')
            .send({ command: 'build' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.errors).toBe('Build FAILED.');
        expect(res.body.exitCode).toBe(1);
    });

    test('no arguments provided defaults to empty array', async () => {
        mockExec({ stdout: 'OK', stderr: '', error: null });

        const res = await request(app)
            .post('/run-command')
            .send({ command: 'restore' });

        expect(res.status).toBe(200);
        expect(res.body.command).toBe('dotnet restore');
    });

    test('all DOTNET_COMMANDS keys are accepted', async () => {
        const keys = ['build', 'clean', 'restore', 'test', 'testWithCoverage', 'format', 'formatVerify', 'pack', 'publish'];
        for (const key of keys) {
            mockExec({ stdout: 'OK', stderr: '', error: null });
            const res = await request(app)
                .post('/run-command')
                .send({ command: key });
            expect(res.status).toBe(200);
        }
    });

    test('missing command field returns 400 naming the field', async () => {
        const res = await request(app)
            .post('/run-command')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'command'");
        expect(res.body.error).toContain('undefined');
        expect(res.body.supportedCommands).toEqual(
            Object.keys(require('../../src/csharp_test_service').DOTNET_COMMANDS)
        );
    });
});
