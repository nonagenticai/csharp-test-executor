const request = require('supertest');
const { app } = require('../../src/csharp_test_service');

describe('GET /health', () => {
    test('returns 200 status', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
    });

    test('returns healthy status string', async () => {
        const res = await request(app).get('/health');
        expect(res.body.status).toBe('healthy');
    });

    test('returns correct service name', async () => {
        const res = await request(app).get('/health');
        expect(res.body.service).toBe('csharp-test-executor');
    });

    test('returns version string', async () => {
        const res = await request(app).get('/health');
        expect(res.body.version).toBe('1.0.0');
    });

    test('returns ISO timestamp', async () => {
        const res = await request(app).get('/health');
        expect(res.body.timestamp).toBeDefined();
        // Validate it parses as a date
        const parsed = new Date(res.body.timestamp);
        expect(parsed.getTime()).not.toBeNaN();
    });

    test('returns frameworks list in capabilities', async () => {
        const res = await request(app).get('/health');
        expect(res.body.capabilities).toBeDefined();
        expect(res.body.capabilities.frameworks).toEqual(['xunit', 'nunit', 'mstest']);
    });

    test('returns features list in capabilities', async () => {
        const res = await request(app).get('/health');
        expect(res.body.capabilities.features).toEqual(
            expect.arrayContaining([
                'test_execution',
                'code_coverage',
                'static_analysis',
                'package_scanning',
                'format_checking',
                'build_compilation',
                'nuget_management'
            ])
        );
        expect(res.body.capabilities.features).toHaveLength(7);
    });

    test('response is valid JSON with correct content-type', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });
});
