import { describe, expect, it, beforeEach, vi } from 'vitest';

import { GET as resolveViewerSession } from '../session/route';
import { POST as registerViewerSession } from '../register/route';

const sessionHostMock = vi.hoisted(() => ({
  resolveViewerSession: vi.fn(),
  registerViewerSession: vi.fn(),
}));

vi.mock('../../../../../services/api/bff/sessionHost', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../services/api/bff/sessionHost')
  >('../../../../../services/api/bff/sessionHost');
  return {
    ...actual,
    sessionHost: sessionHostMock,
  };
});

describe('viewer API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BFF_SERVICE_SHARED_SECRET;
  });

  it('rejects unauthorized requests when BFF key is required', async () => {
    process.env.BFF_SERVICE_SHARED_SECRET = 'secret';
    const request = new Request('http://localhost/api/viewer/session?clientTag=glasses01', {
      method: 'GET',
    });

    const response = await resolveViewerSession(request);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toBe('unauthorized');
  });

  it('returns viewer session data for a valid clientTag', async () => {
    process.env.BFF_SERVICE_SHARED_SECRET = 'secret';
    sessionHostMock.resolveViewerSession.mockReturnValue({
      clientTag: 'glasses01',
      sessionId: 'sess_view',
      streamUrl: '/api/session/sess_view/stream',
      scenarioKey: 'demo',
      memoryKey: 'demo',
      status: 'CONNECTED',
    });

    const request = new Request('http://localhost/api/viewer/session?clientTag=glasses01', {
      method: 'GET',
      headers: { 'x-bff-key': 'secret' },
    });

    const response = await resolveViewerSession(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.sessionId).toBe('sess_view');
    expect(payload.scenarioKey).toBe('demo');
    expect(sessionHostMock.resolveViewerSession).toHaveBeenCalledWith('glasses01');
  });

  it('registers a clientTag override', async () => {
    process.env.BFF_SERVICE_SHARED_SECRET = 'secret';
    sessionHostMock.registerViewerSession.mockReturnValue({
      clientTag: 'glasses02',
      sessionId: 'sess_new',
      streamUrl: '/api/session/sess_new/stream',
      scenarioKey: 'graffity',
      memoryKey: 'graffity',
      status: 'CONNECTED',
    });

    const request = new Request('http://localhost/api/viewer/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bff-key': 'secret',
      },
      body: JSON.stringify({ clientTag: 'glasses02', sessionId: 'sess_new', scenarioKey: 'graffity' }),
    });

    const response = await registerViewerSession(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.sessionId).toBe('sess_new');
    expect(payload.clientTag).toBe('glasses02');
    expect(sessionHostMock.registerViewerSession).toHaveBeenCalledWith('glasses02', 'sess_new', 'graffity');
  });
});
