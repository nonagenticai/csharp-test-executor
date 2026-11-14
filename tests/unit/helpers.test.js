// Mock child_process before requiring the module
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
    };
});

const { execFile } = require('child_process');
const { executeCommand } = require('../../src/csharp_test_service');

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('executeCommand', () => {
    test('successful command returns correct stdout, stderr, exitCode', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            process.nextTick(() => cb(null, 'hello output', 'some warning'));
            return child;
        });

        const promise = executeCommand(['echo', 'hello']);
        jest.advanceTimersByTime(0);
        // Let process.nextTick fire
        await jest.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(result.stdout).toBe('hello output');
        expect(result.stderr).toBe('some warning');
        expect(result.exitCode).toBe(0);
    });

    test('failed command returns correct error info', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            process.nextTick(() => cb({ code: 2 }, 'partial output', 'error details'));
            return child;
        });

        const promise = executeCommand(['false']);
        await jest.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.stdout).toBe('partial output');
        expect(result.stderr).toBe('error details');
        expect(result.exitCode).toBe(2);
    });

    test('error with no code defaults exitCode to 1', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            process.nextTick(() => cb({ code: undefined }, '', 'error'));
            return child;
        });

        const promise = executeCommand(['badcmd']);
        await jest.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
    });

    test('error with code 0 reports success as true', async () => {
        // Odd case: error object present but code is 0
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            process.nextTick(() => cb({ code: 0 }, 'output', ''));
            return child;
        });

        const promise = executeCommand(['weird']);
        await jest.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
    });

    test('timeout triggers SIGTERM and returns timeout result', async () => {
        const killFn = jest.fn();
        execFile.mockImplementation(() => {
            return { killed: false, kill: killFn };
        });

        const promise = executeCommand(['sleep', '999'], { timeout: 1000 });

        // Advance past the timeout
        jest.advanceTimersByTime(1001);

        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toBe('Command timed out');
        expect(result.exitCode).toBe(124);
        expect(result.timeout).toBe(true);
        expect(killFn).toHaveBeenCalledWith('SIGTERM');
    });

    // Rewritten 2026-08-16. This test used to assert DOTNET_ROOT === '/root/.dotnet'
    // and a PATH prefixed with it — i.e. it froze the defect in place: nothing has
    // ever been installed at /root/.dotnet in this image (SDK at /usr/share/dotnet,
    // driver at /usr/bin/dotnet), and /root is unusable at runtime because the
    // container has readOnlyRootFilesystem. It passed for the same reason the
    // service was broken: it checked what the code did, not what the image is.
    test('no /root path is injected into the dotnet child environment', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            // Verify env in opts
            expect(opts.env.DOTNET_CLI_TELEMETRY_OPTOUT).toBe('1');
            expect(opts.env.DOTNET_ROOT).toBeUndefined();
            expect(opts.env.PATH || '').not.toContain('/root/.dotnet');
            process.nextTick(() => cb(null, '', ''));
            return child;
        });

        const promise = executeCommand(['dotnet', '--version']);
        await jest.advanceTimersByTimeAsync(1);
        await promise;
    });

    test('custom cwd is passed to exec', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            expect(opts.cwd).toBe('/custom/path');
            process.nextTick(() => cb(null, '', ''));
            return child;
        });

        const promise = executeCommand(['ls'], { cwd: '/custom/path' });
        await jest.advanceTimersByTimeAsync(1);
        await promise;
    });

    test('maxBuffer is set to 20MB', async () => {
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: jest.fn() };
            expect(opts.maxBuffer).toBe(20 * 1024 * 1024);
            process.nextTick(() => cb(null, '', ''));
            return child;
        });

        const promise = executeCommand(['echo', 'test']);
        await jest.advanceTimersByTimeAsync(1);
        await promise;
    });

    test('already killed child does not resolve twice on timeout', async () => {
        const killFn = jest.fn();
        execFile.mockImplementation((file, args, opts, cb) => {
            const child = { killed: false, kill: killFn };
            // Command completes before timeout
            process.nextTick(() => cb(null, 'done', ''));
            return child;
        });

        const promise = executeCommand(['fast', 'cmd'], { timeout: 5000 });
        await jest.advanceTimersByTimeAsync(1);
        const result = await promise;

        // Now advance past the timeout - should not affect the already-resolved result
        jest.advanceTimersByTime(6000);

        expect(result.success).toBe(true);
        expect(result.stdout).toBe('done');
        // kill should not have been called since isResolved was already true
        expect(killFn).not.toHaveBeenCalled();
    });
});
