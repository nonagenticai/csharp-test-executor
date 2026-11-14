const request = require('supertest');
const { app, SUPPORTED_FRAMEWORKS, DOTNET_COMMANDS } = require('../../src/csharp_test_service');

describe('GET /frameworks', () => {
    test('returns 200 status', async () => {
        const res = await request(app).get('/frameworks');
        expect(res.status).toBe(200);
    });

    test('returns supported frameworks object', async () => {
        const res = await request(app).get('/frameworks');
        expect(res.body.supported).toBeDefined();
        expect(res.body.supported.xunit).toBeDefined();
        expect(res.body.supported.nunit).toBeDefined();
        expect(res.body.supported.mstest).toBeDefined();
    });

    test('xunit framework has correct structure', async () => {
        const res = await request(app).get('/frameworks');
        const xunit = res.body.supported.xunit;
        expect(xunit.name).toBe('xUnit');
        expect(xunit.packageReference).toBe('xunit');
        expect(xunit.testAdapterPackage).toBe('xunit.runner.visualstudio');
        expect(xunit.attributes).toEqual(['Fact', 'Theory']);
        expect(xunit.testCommand).toBe('dotnet test');
    });

    test('nunit framework has correct structure', async () => {
        const res = await request(app).get('/frameworks');
        const nunit = res.body.supported.nunit;
        expect(nunit.name).toBe('NUnit');
        expect(nunit.packageReference).toBe('NUnit');
        expect(nunit.testAdapterPackage).toBe('NUnit3TestAdapter');
        expect(nunit.attributes).toEqual(['Test', 'TestCase']);
    });

    test('mstest framework has correct structure', async () => {
        const res = await request(app).get('/frameworks');
        const mstest = res.body.supported.mstest;
        expect(mstest.name).toBe('MSTest');
        expect(mstest.packageReference).toBe('MSTest.TestFramework');
        expect(mstest.testAdapterPackage).toBe('MSTest.TestAdapter');
        expect(mstest.attributes).toEqual(['TestMethod', 'DataTestMethod']);
    });

    test('returns commands object', async () => {
        const res = await request(app).get('/frameworks');
        expect(res.body.commands).toBeDefined();
        expect(res.body.commands.build).toBe('dotnet build');
        expect(res.body.commands.test).toBe('dotnet test');
        expect(res.body.commands.restore).toBe('dotnet restore');
        expect(res.body.commands.clean).toBe('dotnet clean');
        expect(res.body.commands.format).toBe('dotnet format');
    });

    test('returns capabilities object', async () => {
        const res = await request(app).get('/frameworks');
        expect(res.body.capabilities).toBeDefined();
        expect(res.body.capabilities.testExecution).toBe(true);
        expect(res.body.capabilities.codeCoverage).toBe(true);
        expect(res.body.capabilities.staticAnalysis).toBe(true);
        expect(res.body.capabilities.packageScanning).toBe(true);
        expect(res.body.capabilities.multipleFrameworks).toBe(true);
    });

    test('returns target frameworks list', async () => {
        const res = await request(app).get('/frameworks');
        expect(res.body.capabilities.targetFrameworks).toEqual(
            expect.arrayContaining(['net6.0', 'net7.0', 'net8.0'])
        );
    });
});

describe('GET /info', () => {
    test('returns 404 (no /info route defined)', async () => {
        const res = await request(app).get('/info');
        expect(res.status).toBe(404);
    });
});

describe('404 handling', () => {
    test('unknown GET route returns 404', async () => {
        const res = await request(app).get('/nonexistent');
        expect(res.status).toBe(404);
    });

    test('unknown POST route returns 404', async () => {
        const res = await request(app).post('/nonexistent');
        expect(res.status).toBe(404);
    });

    test('unknown PUT route returns 404', async () => {
        const res = await request(app).put('/nonexistent');
        expect(res.status).toBe(404);
    });
});

describe('exported constants', () => {
    test('SUPPORTED_FRAMEWORKS has all three frameworks', () => {
        expect(Object.keys(SUPPORTED_FRAMEWORKS)).toEqual(['xunit', 'nunit', 'mstest']);
    });

    test('DOTNET_COMMANDS has expected commands', () => {
        expect(DOTNET_COMMANDS.build).toBe('dotnet build');
        expect(DOTNET_COMMANDS.clean).toBe('dotnet clean');
        expect(DOTNET_COMMANDS.restore).toBe('dotnet restore');
        expect(DOTNET_COMMANDS.test).toBe('dotnet test');
        expect(DOTNET_COMMANDS.testWithCoverage).toBe('dotnet test --collect:"XPlat Code Coverage"');
        expect(DOTNET_COMMANDS.format).toBe('dotnet format');
        expect(DOTNET_COMMANDS.formatVerify).toBe('dotnet format --verify-no-changes');
        expect(DOTNET_COMMANDS.pack).toBe('dotnet pack');
        expect(DOTNET_COMMANDS.publish).toBe('dotnet publish');
    });
});
