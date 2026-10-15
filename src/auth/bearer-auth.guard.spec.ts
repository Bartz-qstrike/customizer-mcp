import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BearerAuthGuard } from './bearer-auth.guard.js';

const TOKEN = 'a3f1c9d2e8b74f06a1c2d3e4f5a6b7c8';

function guardWith(token: string | undefined) {
  const config = { get: () => token } as unknown as ConfigService;
  return new BearerAuthGuard(config);
}

function contextWith(authorization?: string) {
  const setHeader = vi.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

describe('BearerAuthGuard', () => {
  it('allows everything when no token is configured', () => {
    const { context } = contextWith(undefined);
    expect(guardWith(undefined).canActivate(context)).toBe(true);
    expect(guardWith('   ').canActivate(context)).toBe(true);
  });

  it('allows the correct token', () => {
    const { context } = contextWith(`Bearer ${TOKEN}`);
    expect(guardWith(TOKEN).canActivate(context)).toBe(true);
  });

  it('accepts the scheme case-insensitively', () => {
    const { context } = contextWith(`bearer ${TOKEN}`);
    expect(guardWith(TOKEN).canActivate(context)).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['a wrong token', 'Bearer not-the-token'],
    ['a different-length token', `Bearer ${TOKEN}extra`],
    ['another scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s with 401 and WWW-Authenticate', (_label, header) => {
    const { context, setHeader } = contextWith(header);
    expect(() => guardWith(TOKEN).canActivate(context)).toThrow(
      UnauthorizedException,
    );
    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="customizer-mcp"',
    );
  });
});
