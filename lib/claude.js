// Shared Claude client. Returns null when no API key is set or the SDK is not
// installed, so the app falls back to the offline providers.
let clientPromise = null;

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => new Anthropic())
      .catch(() => {
        console.warn('[claude] ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed. Run "npm install". Using offline mode.');
        return null;
      });
  }
  return clientPromise;
}

// One request that should answer with a single JSON object.
export async function askForJson(client, { system, content, maxTokens = 4000 }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON in model reply.');
  return JSON.parse(text.slice(start, end + 1));
}
