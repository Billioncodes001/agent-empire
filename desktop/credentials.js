const $ = (id) => document.getElementById(id);
const FIELDS = { anthropic: 'anthropicKey', openai: 'openaiKey', github: 'githubToken', openrouter: 'openrouterKey', gemini: 'geminiKey', groq: 'groqKey' };
const NAMES = { anthropicKey: 'Anthropic key', openaiKey: 'OpenAI key', githubToken: 'GitHub token', openrouterKey: 'OpenRouter key', geminiKey: 'Gemini key', groqKey: 'Groq key' };
async function paint() {
  const s = await window.providerKeys.state();
  if (s.error) { $('state').textContent = s.error; return; }
  const keys = s.keys || { anthropicKey: s.anthropic, githubToken: s.github };
  $('state').textContent = Object.entries(NAMES).map(([k, label]) => `${label}: ${keys[k] ? 'saved' : 'not saved'}`).join(' · ');
}
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const value = {};
  for (const [id, field] of Object.entries(FIELDS)) value[field] = $(id).value;
  const hosted = ['openrouter', 'gemini', 'groq'].some((id) => $(id).value.trim());
  if (hosted && !$('terms').checked) { $('status').textContent = 'Read and confirm the free hosted providers’ data-use terms before saving their keys.'; $('terms').focus(); return; }
  value.acceptedHostedTerms = $('terms').checked;
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const r = await window.providerKeys.save(value);
    $('status').textContent = r.error || r.message || '';
  } finally {
    for (const id of Object.keys(FIELDS)) $(id).value = '';
    $('terms').checked = false;
    buttons.forEach((b) => (b.disabled = false));
    await paint();
  }
};
$('close').onclick = () => window.close();
void paint();
