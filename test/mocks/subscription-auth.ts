/** Synthetic personal-login fixtures; contains no valid credentials. */
export function personalAuth(plan = 'pro', account = 'synthetic-account', user = 'synthetic-user', generation = 1) {
  const jwt = (value: unknown) =>
    [
      Buffer.from('{"alg":"RS256"}').toString('base64url'),
      Buffer.from(JSON.stringify(value)).toString('base64url'),
      'c3ludGhldGlj',
    ].join('.');
  const claims = {
    'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: account, chatgpt_user_id: user },
    iat: generation,
  };
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt(claims),
      access_token: jwt(claims),
      refresh_token: 'synthetic-refresh-' + generation,
      account_id: account,
    },
    last_refresh: '2026-10-17T00:00:00Z',
  };
}
