const os = require('os');
const path = require('path');
const realFs = require('fs');

// Mock child_process before requiring the app
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        execFile: jest.fn()
    };
});

const { execFile } = require('child_process');
const { executeCommand, ensureOfflineNuGetConfig } = require('../../src/csharp_test_service');

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
// executeCommand hardcoded DOTNET_ROOT=/root/.dotnet and prefixed PATH with it.
// Nothing has ever lived there in this image (the SDK is at /usr/share/dotnet,
// the driver at /usr/bin/dotnet), and /root is unwritable under
// readOnlyRootFilesystem.
// ---------------------------------------------------------------------------
describe('dotnet environment is inherited, not hardcoded to /root', () => {
    test('no /root path is injected into the child environment', async () => {
        mockExecSequence([{ stdout: 'ok', stderr: '', error: null }]);
        await executeCommand(['dotnet', '--version']);

        const opts = execFile.mock.calls[0][2];
        expect(opts.env.DOTNET_CLI_TELEMETRY_OPTOUT).toBe('1');
        expect(opts.env.DOTNET_ROOT).toBeUndefined();
        expect(opts.env.PATH).not.toContain('/root/.dotnet');
    });

    test('an explicitly configured DOTNET_ROOT is honoured', async () => {
        const previous = process.env.DOTNET_ROOT;
        process.env.DOTNET_ROOT = '/usr/share/dotnet';
        try {
            mockExecSequence([{ stdout: 'ok', stderr: '', error: null }]);
            await executeCommand(['dotnet', '--version']);
            expect(execFile.mock.calls[0][2].env.DOTNET_ROOT).toBe('/usr/share/dotnet');
        } finally {
            if (previous === undefined) delete process.env.DOTNET_ROOT;
            else process.env.DOTNET_ROOT = previous;
        }
    });
});

// ---------------------------------------------------------------------------
// Offline NuGet config. Measured in a --network none container: 42.4s per
// scaffold with nuget.org configured vs 3.9s with sources cleared. The packages
// come from NUGET_FALLBACK_PACKAGES either way.
// ---------------------------------------------------------------------------
describe('ensureOfflineNuGetConfig', () => {
    let home;

    beforeEach(() => {
        home = realFs.mkdtempSync(path.join(os.tmpdir(), 'nugethome-'));
    });

    afterEach(() => {
        realFs.rmSync(home, { recursive: true, force: true });
    });

    test('writes a sources-clearing config at the ONLY path the SDK honours', async () => {
        const result = await ensureOfflineNuGetConfig({ home, fallback: '/opt/nuget-fallback' });

        expect(result.written).toBe(true);
        // /etc/NuGet was measured to be ignored by this SDK; $HOME/.nuget/NuGet is not.
        expect(result.path).toBe(path.join(home, '.nuget', 'NuGet', 'NuGet.Config'));
        const content = realFs.readFileSync(result.path, 'utf8');
        expect(content).toContain('<clear />');
        expect(content).toContain('<packageSources>');
    });

    test('is a no-op without a baked fallback folder — clearing sources offline-breaks an online host', async () => {
        const result = await ensureOfflineNuGetConfig({ home, fallback: undefined });

        expect(result.written).toBe(false);
        expect(realFs.existsSync(path.join(home, '.nuget'))).toBe(false);
    });

    // Injected rather than acted out on the filesystem. The first version of this
    // test pointed HOME at a bogus path under /proc; that passed on macOS and HUNG
    // for the full 5s jest timeout on the Linux CI runner. An unwritable-directory
    // fixture is also a lie when the process is root, which it is in some images.
    test('an unwritable HOME warns instead of killing the boot', async () => {
        const spy = jest
            .spyOn(realFs.promises, 'mkdir')
            .mockRejectedValueOnce(new Error("EROFS: read-only file system, mkdir '/root/.nuget/NuGet'"));
        try {
            const result = await ensureOfflineNuGetConfig({ home, fallback: '/opt/nuget-fallback' });

            expect(result.written).toBe(false);
            expect(result.reason).toContain('EROFS');
        } finally {
            spy.mockRestore();
        }
    });
});
